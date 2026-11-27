import * as argon2 from "argon2";
import { jest } from "@jest/globals";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import {
  UserStatus,
  VerificationChallengePurpose,
  Prisma,
} from "../src/generated/prisma/client.js";
import { AuthController } from "../src/identity/auth/auth.controller.js";
import { AuthService } from "../src/identity/auth/auth.service.js";
import { AuditLogService } from "../src/identity/audit/audit-log.service.js";
import { EmailDeliveryUnavailableError } from "../src/identity/email/email-delivery.js";
import { VerificationEmailOutboxService } from "../src/identity/email/verification-email-outbox.service.js";
import { SecurityPrimitives } from "../src/identity/security/security-primitives.js";
import { PrismaService } from "../src/database/prisma.service.js";

const USER_ID = "123e4567-e89b-42d3-a456-426614174000";
const CHALLENGE_ID = "123e4567-e89b-42d3-a456-426614174001";
const EMAIL = "person@example.com";
const TOKEN = "verification-token";

function asyncMock() {
  return jest.fn<(...args: unknown[]) => Promise<unknown>>();
}

function createHarness() {
  const transaction = {
    user: {
      create: asyncMock().mockResolvedValue({
        id: USER_ID,
        email: EMAIL,
        verificationChallenges: [{ id: CHALLENGE_ID }],
      }),
      findUnique: asyncMock().mockResolvedValue({
        id: USER_ID,
        status: UserStatus.PENDING_VERIFICATION,
        emailVerifiedAt: null,
      }),
      updateMany: asyncMock().mockResolvedValue({ count: 1 }),
    },
    verificationChallenge: {
      create: asyncMock().mockResolvedValue({ id: CHALLENGE_ID }),
      findUnique: asyncMock().mockResolvedValue({
        id: CHALLENGE_ID,
        userId: USER_ID,
        purpose: VerificationChallengePurpose.EMAIL_VERIFICATION,
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
        attemptCount: 0,
      }),
      findMany: asyncMock().mockResolvedValue([]),
      updateMany: asyncMock().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: asyncMock().mockResolvedValue([]),
  };
  const prisma = {
    ...transaction,
    $transaction: jest.fn(
      async <T>(callback: (client: typeof transaction) => Promise<T>) =>
        callback(transaction),
    ),
  };
  const auditLog = {
    record: jest
      .fn<AuditLogService["record"]>()
      .mockResolvedValue(undefined),
  };
  const emailOutbox = {
    ensureAvailable: jest.fn<VerificationEmailOutboxService["ensureAvailable"]>(),
    enqueue: jest
      .fn<VerificationEmailOutboxService["enqueue"]>()
      .mockResolvedValue(undefined),
  };
  const service = new AuthService(
    prisma as unknown as PrismaService,
    auditLog as unknown as AuditLogService,
    new SecurityPrimitives(),
    emailOutbox as unknown as VerificationEmailOutboxService,
  );

  return { service, prisma, transaction, auditLog, emailOutbox };
}

describe("Identity lifecycle service", () => {
  it("creates a normalized pending account, an Argon2id credential and a digested challenge", async () => {
    const harness = createHarness();

    await harness.service.register(EMAIL, "a-secure-password-123");

    const createArgs = harness.transaction.user.create.mock.calls[0]?.[0] as {
      data: {
        email: string;
        status: UserStatus;
        passwordCredential: { create: { passwordHash: string } };
        verificationChallenges: {
          create: {
            tokenHash: string;
            expiresAt: Date;
            purpose: VerificationChallengePurpose;
          };
        };
      };
    };
    const passwordHash =
      createArgs.data.passwordCredential.create.passwordHash as string;
    const challengeData =
      createArgs.data.verificationChallenges.create as {
        tokenHash: string;
        expiresAt: Date;
        purpose: VerificationChallengePurpose;
      };
    const queued = harness.emailOutbox.enqueue.mock.calls[0]?.[1];

    expect(await argon2.verify(passwordHash, "a-secure-password-123")).toBe(
      true,
    );
    expect(passwordHash).not.toContain("a-secure-password-123");
    expect(passwordHash).toMatch(/^\$argon2id\$/);
    expect(createArgs.data.email).toBe(EMAIL);
    expect(createArgs.data.status).toBe(UserStatus.PENDING_VERIFICATION);
    expect(challengeData.purpose).toBe(
      VerificationChallengePurpose.EMAIL_VERIFICATION,
    );
    expect(challengeData.tokenHash).toBe(
      new SecurityPrimitives().digestOpaqueToken(queued.token),
    );
    expect(challengeData.tokenHash).not.toBe(queued.token);
    expect(challengeData.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(challengeData.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 30 * 60 * 1000,
    );
    expect(harness.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "AUTH.REGISTRATION_COMPLETED" }),
      harness.transaction,
    );
    expect(harness.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUTH.VERIFICATION_EMAIL_REQUESTED",
      }),
      harness.transaction,
    );
  });

  it("treats a concurrent email uniqueness conflict as a generic duplicate", async () => {
    const harness = createHarness();
    harness.transaction.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["email"] },
      }),
    );

    await expect(
      harness.service.register(EMAIL, "a-secure-password-123"),
    ).resolves.toBeUndefined();

    expect(harness.emailOutbox.enqueue).not.toHaveBeenCalled();
    expect(harness.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUTH.REGISTRATION_DUPLICATE",
      }),
    );
  });

  it("does not mistake an unrelated unique collision for a duplicate account", async () => {
    const harness = createHarness();
    const uniquenessError = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["verification_challenges_token_hash_key"] },
      },
    );
    harness.transaction.user.create.mockRejectedValue(uniquenessError);
    harness.prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      harness.service.register(EMAIL, "a-secure-password-123"),
    ).rejects.toBe(uniquenessError);
    expect(harness.auditLog.record).not.toHaveBeenCalled();
    expect(harness.emailOutbox.enqueue).not.toHaveBeenCalled();
  });

  it("allows only one concurrent registration for a normalized email", async () => {
    const harness = createHarness();
    let attempts = 0;
    harness.transaction.user.create.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          id: USER_ID,
          email: EMAIL,
          verificationChallenges: [{ id: CHALLENGE_ID }],
        };
      }

      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed",
        {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["users_email_normalized_key"] },
        },
      );
    });

    await Promise.all([
      harness.service.register(EMAIL, "a-secure-password-123"),
      harness.service.register(EMAIL, "a-secure-password-123"),
    ]);

    expect(harness.transaction.user.create).toHaveBeenCalledTimes(2);
    expect(
      harness.emailOutbox.enqueue,
    ).toHaveBeenCalledTimes(1);
  });

  it("does not deliver or write audit records when account creation rolls back", async () => {
    const harness = createHarness();
    harness.transaction.user.create.mockRejectedValue(
      new Error("database failure"),
    );

    await expect(
      harness.service.register(EMAIL, "a-secure-password-123"),
    ).rejects.toThrow("database failure");

    expect(harness.emailOutbox.enqueue).not.toHaveBeenCalled();
    expect(harness.auditLog.record).not.toHaveBeenCalled();
  });

  it("requires delivery configuration before any database access", async () => {
    const harness = createHarness();
    harness.emailOutbox.ensureAvailable.mockImplementation(() => {
      throw new EmailDeliveryUnavailableError();
    });

    await expect(
      harness.service.register(EMAIL, "a-secure-password-123"),
    ).rejects.toThrow("Email delivery is temporarily unavailable.");
    expect(harness.prisma.$transaction).not.toHaveBeenCalled();
    expect(harness.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("activates a pending account only after an atomic challenge consumption", async () => {
    const harness = createHarness();

    await harness.service.verifyEmail(TOKEN);

    expect(
      harness.transaction.verificationChallenge.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          purpose: VerificationChallengePurpose.EMAIL_VERIFICATION,
          consumedAt: null,
          attemptCount: { lt: 5 },
        }),
        data: { consumedAt: expect.any(Date) },
      }),
    );
    expect(harness.transaction.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: USER_ID,
          status: UserStatus.PENDING_VERIFICATION,
          emailVerifiedAt: null,
        },
        data: {
          status: UserStatus.ACTIVE,
          emailVerifiedAt: expect.any(Date),
        },
      }),
    );
    expect(harness.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "AUTH.EMAIL_VERIFIED" }),
      harness.transaction,
    );
  });

  it.each([
    ["unknown token", null],
    ["expired", { expiresAt: new Date(Date.now() - 1) }],
    ["wrong purpose", { purpose: VerificationChallengePurpose.PASSWORD_RESET }],
    ["consumed", { consumedAt: new Date() }],
    ["exhausted", { attemptCount: 5 }],
  ])("rejects a %s verification challenge", async (_label, overrides) => {
    const harness = createHarness();
    harness.transaction.verificationChallenge.findUnique.mockResolvedValue(
      overrides === null
        ? null
        : {
            id: CHALLENGE_ID,
            userId: USER_ID,
            purpose: VerificationChallengePurpose.EMAIL_VERIFICATION,
            expiresAt: new Date(Date.now() + 60_000),
            consumedAt: null,
            attemptCount: 0,
            ...overrides,
          },
    );

    await expect(harness.service.verifyEmail(TOKEN)).rejects.toThrow(
      "Verification token is invalid or expired.",
    );
    expect(
      harness.transaction.verificationChallenge.updateMany,
    ).not.toHaveBeenCalled();
    expect(harness.transaction.user.updateMany).not.toHaveBeenCalled();
  });

  it("rejects replay when conditional challenge consumption loses a race", async () => {
    const harness = createHarness();
    harness.transaction.verificationChallenge.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const outcomes = await Promise.allSettled([
      harness.service.verifyEmail(TOKEN),
      harness.service.verifyEmail(TOKEN),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(harness.transaction.user.updateMany).toHaveBeenCalledTimes(1);
    expect(harness.auditLog.record).toHaveBeenCalledTimes(1);
  });

  it("does not activate an already verified account", async () => {
    const harness = createHarness();
    harness.transaction.user.updateMany.mockResolvedValue({ count: 0 });

    await expect(harness.service.verifyEmail(TOKEN)).rejects.toThrow(
      "Verification token is invalid or expired.",
    );
    expect(harness.auditLog.record).not.toHaveBeenCalled();
  });

  it("issues a fresh challenge under the per-account database lock", async () => {
    const harness = createHarness();

    await harness.service.resendVerification(EMAIL);

    expect(harness.transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(
      harness.transaction.verificationChallenge.create,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          purpose: VerificationChallengePurpose.EMAIL_VERIFICATION,
          tokenHash: expect.any(String),
          expiresAt: expect.any(Date),
        }),
      }),
    );
    expect(harness.emailOutbox.enqueue).toHaveBeenCalledWith(
      harness.transaction,
      expect.objectContaining({
        challengeId: CHALLENGE_ID,
        token: expect.any(String),
      }),
    );
  });

  it("returns the same successful service outcome for a nonexistent account", async () => {
    const harness = createHarness();
    harness.prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      harness.service.resendVerification(EMAIL),
    ).resolves.toBeUndefined();
    expect(harness.transaction.verificationChallenge.create).not.toHaveBeenCalled();
    expect(harness.emailOutbox.enqueue).not.toHaveBeenCalled();
    expect(harness.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUTH.VERIFICATION_RESEND_REQUESTED",
        outcome: "NOT_ELIGIBLE",
      }),
    );
  });

  it("does not resend for verified accounts or accounts in the cooldown", async () => {
    const verified = createHarness();
    verified.transaction.user.findUnique.mockResolvedValue({
      id: USER_ID,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
    });
    await verified.service.resendVerification(EMAIL);

    const coolingDown = createHarness();
    coolingDown.transaction.verificationChallenge.findMany.mockResolvedValue([
      { createdAt: new Date() },
    ]);
    await coolingDown.service.resendVerification(EMAIL);

    expect(
      verified.transaction.verificationChallenge.create,
    ).not.toHaveBeenCalled();
    expect(
      coolingDown.transaction.verificationChallenge.create,
    ).not.toHaveBeenCalled();
    expect(verified.emailOutbox.enqueue).not.toHaveBeenCalled();
    expect(coolingDown.emailOutbox.enqueue).not.toHaveBeenCalled();
  });

  it("enforces the rolling-hour challenge limit", async () => {
    const harness = createHarness();
    harness.transaction.verificationChallenge.findMany.mockResolvedValue([
      { createdAt: new Date(Date.now() - 10 * 60_000) },
      { createdAt: new Date(Date.now() - 20 * 60_000) },
      { createdAt: new Date(Date.now() - 30 * 60_000) },
    ]);

    await harness.service.resendVerification(EMAIL);

    expect(
      harness.transaction.verificationChallenge.create,
    ).not.toHaveBeenCalled();
    expect(harness.emailOutbox.enqueue).not.toHaveBeenCalled();
  });
});

describe("Identity lifecycle HTTP endpoints", () => {
  let app: INestApplication;
  const authService = {
    register: asyncMock().mockResolvedValue(undefined),
    verifyEmail: asyncMock().mockResolvedValue(undefined),
    resendVerification: asyncMock().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("normalizes registration email and returns no credential material", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ email: "  PERSON@EXAMPLE.COM ", password: "a-secure-password" })
      .expect(202);

    expect(authService.register).toHaveBeenCalledWith(
      "person@example.com",
      "a-secure-password",
    );
    expect(JSON.stringify(response.body)).not.toContain("a-secure-password");
    expect(response.body).toEqual({
      message: expect.any(String),
    });
  });

  it.each(["short", "p".repeat(129)])(
    "rejects a password outside the 12 to 128 character policy",
    async (password) => {
      const response = await request(app.getHttpServer())
        .post("/api/v1/auth/register")
        .send({ email: "person@example.com", password })
        .expect(400);

      expect(JSON.stringify(response.body)).not.toContain(password);
      expect(authService.register).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed registration email addresses", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({ email: "not-an-email", password: "a-secure-password" })
      .expect(400);

    expect(authService.register).not.toHaveBeenCalled();
  });

  it("returns generic resend acknowledgements without exposing account state", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/auth/resend-verification")
      .send({ email: "person@example.com" })
      .expect(202);

    expect(authService.resendVerification).toHaveBeenCalledWith(EMAIL);
    expect(response.body).toEqual({ message: expect.any(String) });
  });

  it("does not expose verification tokens in verification responses", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/v1/auth/verify-email")
      .send({ token: TOKEN })
      .expect(200);

    expect(response.body).not.toHaveProperty("token");
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
  });
});
