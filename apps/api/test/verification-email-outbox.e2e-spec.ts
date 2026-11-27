import { jest } from "@jest/globals";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "../src/generated/prisma/client.js";
import { PrismaService } from "../src/database/prisma.service.js";
import {
  AuditLogService,
  sanitizeAuditMetadata,
} from "../src/identity/audit/audit-log.service.js";
import {
  EmailDeliveryError,
  EmailDeliveryUnavailableError,
} from "../src/identity/email/email-delivery.js";
import type {
  EmailDelivery,
  VerificationEmail,
} from "../src/identity/email/email-delivery.js";
import {
  calculateRetryDelaySeconds,
  VerificationEmailOutboxService,
} from "../src/identity/email/verification-email-outbox.service.js";
import { SecurityPrimitives } from "../src/identity/security/security-primitives.js";

const KEY = Buffer.alloc(32, 11);
const TOKEN = "opaque-verification-token";
const OUTBOX_ID = "123e4567-e89b-42d3-a456-426614174002";
const CHALLENGE_ID = "123e4567-e89b-42d3-a456-426614174001";
const USER_ID = "123e4567-e89b-42d3-a456-426614174003";
const LOCK_TOKEN = "123e4567-e89b-42d3-a456-426614174004";

interface ChallengeFixture {
  readonly id: string;
  readonly user_id: string;
  readonly purpose: string;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly dispatchable: boolean;
}

interface UserFixture {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly email_verified_at: Date | null;
}

interface HarnessOptions {
  readonly deliveryAttempts?: number;
  readonly claimCount?: number;
  readonly challenge?: ChallengeFixture | null;
  readonly user?: UserFixture | null;
  readonly latestChallengeId?: string | null;
  readonly deliveryError?: Error;
  readonly availabilityError?: Error;
  readonly ciphertext?: string;
  readonly claimTokenValid?: boolean;
  readonly staleAfterAttempt?: boolean;
  readonly wasAbandoned?: boolean;
  readonly crashBeforeAttempt?: boolean;
  readonly failDeliveryPersistence?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const securityPrimitives = new SecurityPrimitives();
  const encryptedToken = securityPrimitives.encryptOpaqueToken(TOKEN, KEY);
  let claimCount = options.claimCount ?? 0;
  let abandonedClaimCount = 0;
  let claimSequence = 0;
  let crashBeforeAttempt = options.crashBeforeAttempt ?? false;
  const record = {
    id: OUTBOX_ID,
    challenge_id: CHALLENGE_ID,
    token_ciphertext: options.ciphertext ?? encryptedToken.ciphertext,
    token_nonce: encryptedToken.nonce,
    token_auth_tag: encryptedToken.authTag,
    delivery_attempts: options.deliveryAttempts ?? 0,
    claim_count: claimCount,
    abandoned_claim_count: 0,
    was_abandoned: options.wasAbandoned ?? false,
    lock_token: LOCK_TOKEN,
  };
  const challenge: ChallengeFixture | null =
    options.challenge === undefined
      ? {
          id: CHALLENGE_ID,
          user_id: USER_ID,
          purpose: "EMAIL_VERIFICATION",
          expires_at: new Date("2030-01-01T00:00:00.000Z"),
          consumed_at: null,
          dispatchable: true,
        }
      : options.challenge;
  const user: UserFixture | null =
    options.user === undefined
      ? {
          id: USER_ID,
          email: "person@example.com",
          status: "PENDING_VERIFICATION",
          email_verified_at: null,
        }
      : options.user;
  const latestChallengeId =
    options.latestChallengeId === undefined
      ? challenge?.id
      : options.latestChallengeId;

  const queryRaw = jest.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      void values;
      const query = strings.join(" ");

      if (query.includes("WITH candidates")) {
        claimSequence += 1;
        claimCount += 1;
        if (options.wasAbandoned) {
          abandonedClaimCount += 1;
        }
        record.claim_count = claimCount;
        record.abandoned_claim_count = abandonedClaimCount;
        record.was_abandoned = options.wasAbandoned ?? false;
        record.lock_token =
          claimSequence === 1
            ? LOCK_TOKEN
            : `123e4567-e89b-42d3-a456-${String(426614174003 + claimSequence).padStart(12, "0")}`;
        return [record];
      }
      if (
        query.includes('FROM "verification_email_outbox"') &&
        query.includes("FOR UPDATE")
      ) {
        if (crashBeforeAttempt) {
          throw new Error("Simulated worker crash before dispatch reservation.");
        }
        return options.claimTokenValid === false
          ? []
          : [{ id: OUTBOX_ID, delivery_attempts: record.delivery_attempts }];
      }
      if (
        query.includes('FROM "verification_challenges"') &&
        query.includes("FOR UPDATE")
      ) {
        return challenge ? [challenge] : [];
      }
      if (query.includes('FROM "users"')) {
        return user ? [user] : [];
      }
      if (
        query.includes('FROM "verification_challenges"') &&
        query.includes('ORDER BY "created_at" DESC')
      ) {
        return latestChallengeId ? [{ id: latestChallengeId }] : [];
      }

      throw new Error("Unexpected outbox test query.");
    },
  );
  const executeRaw = jest.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      void values;
      if (
        options.failDeliveryPersistence &&
        strings.join(" ").includes('"delivered_at" = NOW()')
      ) {
        throw new Error("Simulated persistence failure after provider acceptance.");
      }
      return 1;
    },
  );
  const transaction = { $queryRaw: queryRaw, $executeRaw: executeRaw };
  const deliveryAttemptQuery = jest.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      void values;
      const query = strings.join(" ");
      if (options.claimTokenValid === false || record.delivery_attempts >= 8) {
        return [];
      }
      if (
        !query.includes('"last_delivery_attempt_lock_token" IS DISTINCT FROM "lock_token"')
      ) {
        throw new Error("Delivery attempt must be fenced by its claim token.");
      }
      record.delivery_attempts += 1;
      if (options.staleAfterAttempt) {
        options = { ...options, claimTokenValid: false };
      }
      return [{ delivery_attempts: record.delivery_attempts }];
    },
  );
  const prisma = {
    $transaction: jest.fn(
      async <T>(callback: (client: typeof transaction) => Promise<T>) =>
        callback(transaction),
    ),
    $queryRaw: deliveryAttemptQuery,
  };
  const auditLog = {
    record: jest.fn(async (...args: unknown[]) => {
      void args;
    }),
  };
  const sendVerificationEmail = jest.fn(
    async (message: VerificationEmail): Promise<void> => {
      void message;
      if (options.deliveryError) {
        throw options.deliveryError;
      }
    },
  );
  const emailDelivery: EmailDelivery = {
    ensureAvailable: jest.fn(() => {
      if (options.availabilityError) {
        throw options.availabilityError;
      }
    }),
    sendVerificationEmail,
  };
  const service = new VerificationEmailOutboxService(
    prisma as unknown as PrismaService,
    auditLog as unknown as AuditLogService,
    securityPrimitives,
    {
      getOrThrow: () => KEY,
    } as unknown as ConfigService,
    emailDelivery,
  );

  return {
    auditLog,
    deliveryAttemptQuery,
    executeRaw,
    prisma,
    queryRaw,
    record,
    sendVerificationEmail,
    service,
    transaction,
    setCrashBeforeAttempt: (value: boolean) => {
      crashBeforeAttempt = value;
    },
  };
}

describe("VerificationEmailOutboxService", () => {
  it("stores an encrypted token through the caller's transaction", async () => {
    const token = TOKEN;
    const executeRaw = jest.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        void strings;
        void values;
        return 1;
      },
    );
    const transaction = {
      $executeRaw: executeRaw,
    } as unknown as Prisma.TransactionClient;
    const securityPrimitives = new SecurityPrimitives();
    const service = new VerificationEmailOutboxService(
      {} as PrismaService,
      {} as AuditLogService,
      securityPrimitives,
      {
        getOrThrow: () => KEY,
      } as unknown as ConfigService,
      {
        ensureAvailable: jest.fn(),
        sendVerificationEmail: jest.fn(),
      } as EmailDelivery,
    );

    await service.enqueue(transaction, { challengeId: CHALLENGE_ID, token });

    const parameters = executeRaw.mock.calls[0]?.slice(1) ?? [];
    expect(parameters).toContain(CHALLENGE_ID);
    expect(parameters).not.toContain(token);
    expect(
      securityPrimitives.decryptOpaqueToken(
        {
          ciphertext: parameters[1] as string,
          nonce: parameters[2] as string,
          authTag: parameters[3] as string,
        },
        KEY,
      ),
    ).toBe(token);
  });

  it.each([
    ["missing challenge", { challenge: null }, "CHALLENGE_NOT_FOUND"],
    [
      "wrong-purpose challenge",
      {
        challenge: {
          id: CHALLENGE_ID,
          user_id: USER_ID,
          purpose: "PASSWORD_RESET",
          expires_at: new Date("2030-01-01T00:00:00.000Z"),
          consumed_at: null,
          dispatchable: true,
        },
      },
      "WRONG_CHALLENGE_PURPOSE",
    ],
    [
      "consumed challenge",
      {
        challenge: {
          id: CHALLENGE_ID,
          user_id: USER_ID,
          purpose: "EMAIL_VERIFICATION",
          expires_at: new Date("2030-01-01T00:00:00.000Z"),
          consumed_at: new Date("2029-01-01T00:00:00.000Z"),
          dispatchable: true,
        },
      },
      "CHALLENGE_CONSUMED",
    ],
    [
      "expired challenge",
      {
        challenge: {
          id: CHALLENGE_ID,
          user_id: USER_ID,
          purpose: "EMAIL_VERIFICATION",
          expires_at: new Date("2029-01-01T00:00:00.000Z"),
          consumed_at: null,
          dispatchable: false,
        },
      },
      "CHALLENGE_EXPIRED",
    ],
    [
      "superseded challenge",
      { latestChallengeId: "123e4567-e89b-42d3-a456-426614174005" },
      "CHALLENGE_SUPERSEDED",
    ],
    [
      "verified account",
      {
        user: {
          id: USER_ID,
          email: "person@example.com",
          status: "ACTIVE",
          email_verified_at: new Date("2029-01-01T00:00:00.000Z"),
        },
      },
      "ACCOUNT_NOT_PENDING",
    ],
  ])("terminalizes a %s without sending", async (_name, options, code) => {
    const harness = createHarness(options);

    await harness.service.dispatchPending();

    expect(harness.sendVerificationEmail).not.toHaveBeenCalled();
    expect(harness.executeRaw.mock.calls.some(([strings]) =>
      strings.join(" ").includes('"failed_at" = NOW()'),
    )).toBe(true);
    expect(harness.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "TERMINAL",
        metadata: expect.objectContaining({ failureCode: code }),
      }),
      harness.transaction,
    );
  });

  it("sends a current challenge and records provider acceptance", async () => {
    const harness = createHarness();

    await harness.service.dispatchPending();

    expect(harness.sendVerificationEmail).toHaveBeenCalledWith({
      email: "person@example.com",
      token: TOKEN,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(harness.executeRaw.mock.calls.some(([strings]) =>
      strings.join(" ").includes('"delivered_at" = NOW()'),
    )).toBe(true);
    expect(harness.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUTH.VERIFICATION_EMAIL_PROVIDER_ACCEPTED",
        outcome: "SUCCESS",
      }),
      harness.transaction,
    );
  });

  it("uses capped exponential retry delays", () => {
    expect(calculateRetryDelaySeconds(1)).toBe(60);
    expect(calculateRetryDelaySeconds(2)).toBe(120);
    expect(calculateRetryDelaySeconds(6)).toBe(1920);
    expect(calculateRetryDelaySeconds(7)).toBe(3600);
  });

  it("allows only safe failure metadata through the audit sanitizer", () => {
    expect(
      sanitizeAuditMetadata({
        failureCode: "PROVIDER_TRANSIENT",
        attemptCount: 2,
        claimCount: 9,
        abandonedClaimCount: 4,
        token: TOKEN,
        email: "person@example.com",
        ciphertext: "encrypted-token",
      }),
    ).toEqual({
      failureCode: "PROVIDER_TRANSIENT",
      attemptCount: 2,
      claimCount: 9,
      abandonedClaimCount: 4,
    });
  });

  it("audits transient failures on later attempts and schedules a retry", async () => {
    const harness = createHarness({
      deliveryAttempts: 1,
      claimCount: 37,
      deliveryError: new EmailDeliveryUnavailableError(),
    });

    await harness.service.dispatchPending();

    const retryCall = harness.executeRaw.mock.calls.find(([strings]) =>
      strings.join(" ").includes('"available_at" = NOW() +'),
    );
    expect(retryCall?.slice(1)).toContain(120);
    expect(harness.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "RETRYING",
        metadata: expect.objectContaining({
          attemptCount: 2,
          failureCode: "PROVIDER_TRANSIENT",
        }),
      }),
      harness.transaction,
    );
    expect(harness.auditLog.record).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ token: TOKEN }),
      }),
      expect.anything(),
    );
    const auditEvent = harness.auditLog.record.mock.calls[0]?.[0];
    expect(JSON.stringify(auditEvent)).not.toContain(TOKEN);
    expect(JSON.stringify(auditEvent)).not.toContain(
      harness.record.token_ciphertext,
    );
    expect(JSON.stringify(auditEvent)).not.toContain("person@example.com");
  });

  it("terminalizes a transient failure at the maximum attempt", async () => {
    const harness = createHarness({
      deliveryAttempts: 7,
      deliveryError: new EmailDeliveryUnavailableError(),
    });

    await harness.service.dispatchPending();

    expect(harness.executeRaw.mock.calls.some(([strings]) =>
      strings.join(" ").includes('"failed_at" = NOW()'),
    )).toBe(true);
    expect(harness.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "TERMINAL",
        metadata: expect.objectContaining({
          failureCode: "RETRIES_EXHAUSTED",
        }),
      }),
      harness.transaction,
    );
  });

  it.each([
    [
      "permanent provider rejection",
      new EmailDeliveryError("PERMANENT", "PROVIDER_REJECTED"),
      "PROVIDER_REJECTED",
    ],
    [
      "provider configuration failure",
      new EmailDeliveryUnavailableError(
        "CONFIGURATION",
        "PROVIDER_CONFIGURATION",
      ),
      "PROVIDER_CONFIGURATION",
    ],
    [
      "uncertain delivery",
      new EmailDeliveryUnavailableError("UNCERTAIN", "DELIVERY_UNCERTAIN"),
      "DELIVERY_UNCERTAIN",
    ],
  ])("handles %s with its classified retry policy", async (_name, error, code) => {
    const harness = createHarness({ deliveryError: error });

    await harness.service.dispatchPending();

    if (error instanceof EmailDeliveryError && error.kind === "UNCERTAIN") {
      expect(harness.executeRaw.mock.calls.some(([strings]) =>
        strings.join(" ").includes('"available_at" = NOW() +'),
      )).toBe(true);
      expect(harness.auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "RETRYING",
          metadata: expect.objectContaining({ failureCode: code }),
        }),
        harness.transaction,
      );
    } else {
      expect(harness.executeRaw.mock.calls.some(([strings]) =>
        strings.join(" ").includes('"failed_at" = NOW()'),
      )).toBe(true);
      expect(harness.auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "TERMINAL",
          metadata: expect.objectContaining({ failureCode: code }),
        }),
        harness.transaction,
      );
    }
  });

  it("terminalizes ciphertext decryption failures without calling the provider", async () => {
    const harness = createHarness({ ciphertext: "invalid-ciphertext" });

    await harness.service.dispatchPending();

    expect(harness.sendVerificationEmail).not.toHaveBeenCalled();
    expect(harness.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "TERMINAL",
        metadata: expect.objectContaining({
          failureCode: "DECRYPTION_FAILED",
        }),
      }),
      harness.transaction,
    );
  });

  it("terminalizes a row already exhausted before dispatch", async () => {
    const harness = createHarness({ deliveryAttempts: 8 });

    await harness.service.dispatchPending();

    expect(harness.sendVerificationEmail).not.toHaveBeenCalled();
    expect(harness.deliveryAttemptQuery).not.toHaveBeenCalled();
    expect(harness.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "TERMINAL",
        metadata: expect.objectContaining({
          failureCode: "RETRIES_EXHAUSTED",
        }),
      }),
      harness.transaction,
    );
  });

  it("does not let a stale worker send after its claim token was replaced", async () => {
    const harness = createHarness({ claimTokenValid: false });

    await harness.service.dispatchPending();

    expect(harness.sendVerificationEmail).not.toHaveBeenCalled();
    expect(harness.executeRaw).not.toHaveBeenCalled();
    expect(harness.auditLog.record).not.toHaveBeenCalled();
  });

  it("claims only nonterminal rows using skip-locked leases and claim fencing", async () => {
    const harness = createHarness();

    await harness.service.dispatchPending();

    const claimSql = harness.queryRaw.mock.calls[0]?.[0].join(" ") ?? "";
    expect(claimSql).toContain('"failed_at" IS NULL');
    expect(claimSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(claimSql).toContain('"lock_token" = gen_random_uuid()');
    expect(claimSql).toContain("INTERVAL '1 minute'");
    expect(claimSql).toContain('"claim_count" = outbox."claim_count" + 1');
    expect(claimSql).toContain('"abandoned_claim_count"');
    expect(claimSql).not.toContain('"delivery_attempts" =');
    expect(harness.deliveryAttemptQuery).toHaveBeenCalledTimes(1);
  });

  it("does not spend delivery attempts on repeated abandoned claims", async () => {
    const harness = createHarness({
      wasAbandoned: true,
      crashBeforeAttempt: true,
    });

    for (let claim = 0; claim < 8; claim += 1) {
      await harness.service.dispatchPending();
    }

    expect(harness.deliveryAttemptQuery).not.toHaveBeenCalled();
    expect(harness.sendVerificationEmail).not.toHaveBeenCalled();
    expect(harness.record.claim_count).toBe(8);
    expect(harness.record.abandoned_claim_count).toBe(8);
    expect(harness.auditLog.record).toHaveBeenCalledTimes(8);
    expect(harness.auditLog.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "AUTH.VERIFICATION_EMAIL_CLAIM_ABANDONED",
        metadata: expect.objectContaining({
          claimCount: 8,
          abandonedClaimCount: 8,
          attemptCount: 0,
        }),
      }),
      harness.transaction,
    );

    harness.setCrashBeforeAttempt(false);
    await harness.service.dispatchPending();

    expect(harness.sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(harness.deliveryAttemptQuery).toHaveBeenCalledTimes(1);
    expect(harness.record.delivery_attempts).toBe(1);
  });

  it("records the dispatch reservation before invoking the provider once per claim", async () => {
    const harness = createHarness();
    const eventOrder: string[] = [];
    harness.deliveryAttemptQuery.mockImplementationOnce(async () => {
      eventOrder.push("reservation");
      harness.record.delivery_attempts += 1;
      return [{ delivery_attempts: harness.record.delivery_attempts }];
    });
    harness.sendVerificationEmail.mockImplementationOnce(async () => {
      eventOrder.push("provider");
    });

    await harness.service.dispatchPending();

    expect(eventOrder).toEqual(["reservation", "provider"]);
    expect(harness.deliveryAttemptQuery).toHaveBeenCalledTimes(1);
    expect(harness.deliveryAttemptQuery.mock.calls[0]?.[0].join(" ")).toContain(
      '"last_delivery_attempt_lock_token" IS DISTINCT FROM "lock_token"',
    );
  });

  it("does not send after the claim token is replaced following reservation", async () => {
    const harness = createHarness({ staleAfterAttempt: true });

    await harness.service.dispatchPending();

    expect(harness.deliveryAttemptQuery).toHaveBeenCalledTimes(1);
    expect(harness.record.delivery_attempts).toBe(1);
    expect(harness.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("keeps the dispatch reservation when provider acceptance cannot be persisted", async () => {
    const harness = createHarness({ failDeliveryPersistence: true });

    await harness.service.dispatchPending();

    expect(harness.sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(harness.record.delivery_attempts).toBe(1);
    expect(harness.auditLog.record).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUTH.VERIFICATION_EMAIL_PROVIDER_ACCEPTED",
      }),
      harness.transaction,
    );
  });

  it("terminalizes configuration failures without reserving a delivery attempt", async () => {
    const harness = createHarness({
      availabilityError: new EmailDeliveryUnavailableError(
        "CONFIGURATION",
        "PROVIDER_CONFIGURATION",
      ),
    });

    await harness.service.dispatchPending();

    expect(harness.deliveryAttemptQuery).not.toHaveBeenCalled();
    expect(harness.sendVerificationEmail).not.toHaveBeenCalled();
    expect(harness.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "TERMINAL",
        metadata: expect.objectContaining({
          failureCode: "PROVIDER_CONFIGURATION",
          attemptCount: 0,
        }),
      }),
      harness.transaction,
    );
  });
});
