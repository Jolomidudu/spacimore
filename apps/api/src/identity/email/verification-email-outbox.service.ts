import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AuditActorType,
  Prisma,
  VerificationChallengePurpose,
} from "../../generated/prisma/client.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AuditLogService } from "../audit/audit-log.service.js";
import { SecurityPrimitives } from "../security/security-primitives.js";
import {
  EMAIL_DELIVERY,
  EmailDeliveryError,
} from "./email-delivery.js";
import type {
  EmailDelivery,
  EmailDeliveryFailureCode,
} from "./email-delivery.js";

const POLL_INTERVAL_MS = 5_000;
const LOCK_TIMEOUT_MINUTES = 5;
const BATCH_SIZE = 10;
const MAX_DELIVERY_ATTEMPTS = 8;
const MAX_RETRY_DELAY_SECONDS = 3600;

type OutboxFailureCode =
  | EmailDeliveryFailureCode
  | "ACCOUNT_NOT_PENDING"
  | "CHALLENGE_CONSUMED"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_NOT_FOUND"
  | "CHALLENGE_SUPERSEDED"
  | "DECRYPTION_FAILED"
  | "DELIVERY_INTERNAL_ERROR"
  | "RETRIES_EXHAUSTED"
  | "WRONG_CHALLENGE_PURPOSE";

interface ClaimedOutboxRecord {
  readonly id: string;
  readonly challenge_id: string;
  readonly token_ciphertext: string;
  readonly token_nonce: string;
  readonly token_auth_tag: string;
  readonly delivery_attempts: number;
  readonly claim_count: number;
  readonly abandoned_claim_count: number;
  readonly was_abandoned: boolean;
  readonly lock_token: string;
}

interface LockedChallenge {
  readonly id: string;
  readonly user_id: string;
  readonly purpose: string;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly dispatchable: boolean;
}

interface LockedUser {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly email_verified_at: Date | null;
}

interface DispatchContext {
  readonly challenge: LockedChallenge;
  readonly user: LockedUser;
}

export function calculateRetryDelaySeconds(attempt: number): number {
  return Math.min(
    MAX_RETRY_DELAY_SECONDS,
    30 * 2 ** Math.min(Math.max(attempt, 1), 7),
  );
}

@Injectable()
export class VerificationEmailOutboxService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(VerificationEmailOutboxService.name);
  private readonly encryptionKey: Buffer;
  private timer: NodeJS.Timeout | undefined;
  private processing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly securityPrimitives: SecurityPrimitives,
    configService: ConfigService,
    @Inject(EMAIL_DELIVERY) private readonly emailDelivery: EmailDelivery,
  ) {
    this.encryptionKey = configService.getOrThrow<Buffer>(
      "identitySecurity.outboxEncryptionKey",
    );
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.dispatchPending().catch(() => {
        this.logger.error("Verification email outbox processing failed.");
      });
    }, POLL_INTERVAL_MS);
    this.timer.unref();
    void this.dispatchPending().catch(() => {
      this.logger.error("Verification email outbox processing failed.");
    });
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  ensureAvailable(): void {
    this.emailDelivery.ensureAvailable();
  }

  async enqueue(
    transaction: Prisma.TransactionClient,
    input: {
      readonly challengeId: string;
      readonly token: string;
    },
  ): Promise<void> {
    const encryptedToken = this.securityPrimitives.encryptOpaqueToken(
      input.token,
      this.encryptionKey,
    );

    await transaction.$executeRaw`
      INSERT INTO "verification_email_outbox" (
        "id",
        "challenge_id",
        "token_ciphertext",
        "token_nonce",
        "token_auth_tag"
      ) VALUES (
        gen_random_uuid(),
        ${input.challengeId}::uuid,
        ${encryptedToken.ciphertext},
        ${encryptedToken.nonce},
        ${encryptedToken.authTag}
      )
    `;
  }

  async dispatchPending(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      const records = await this.claimBatch();
      for (const record of records) {
        await this.deliver(record);
      }
    } finally {
      this.processing = false;
    }
  }

  private async claimBatch(): Promise<ClaimedOutboxRecord[]> {
    return this.prisma.$transaction(async (transaction) => {
      const records = await transaction.$queryRaw<ClaimedOutboxRecord[]>`
        WITH candidates AS (
          SELECT
            "id",
            (
              "locked_at" IS NOT NULL
              AND "locked_at" < NOW() - (${LOCK_TIMEOUT_MINUTES} * INTERVAL '1 minute')
            ) AS "was_abandoned"
          FROM "verification_email_outbox"
          WHERE "delivered_at" IS NULL
            AND "failed_at" IS NULL
            AND "available_at" <= NOW()
            AND (
              "locked_at" IS NULL
              OR "locked_at" < NOW() - (${LOCK_TIMEOUT_MINUTES} * INTERVAL '1 minute')
            )
          ORDER BY "created_at"
          FOR UPDATE SKIP LOCKED
          LIMIT ${BATCH_SIZE}
        )
        UPDATE "verification_email_outbox" AS outbox
        SET
          "locked_at" = NOW(),
          "lock_token" = gen_random_uuid(),
          "claim_count" = outbox."claim_count" + 1,
          "abandoned_claim_count" = outbox."abandoned_claim_count"
            + CASE WHEN candidates."was_abandoned" THEN 1 ELSE 0 END
        FROM candidates
        WHERE outbox."id" = candidates."id"
        RETURNING
          outbox."id",
          outbox."challenge_id",
          outbox."token_ciphertext",
          outbox."token_nonce",
          outbox."token_auth_tag",
          outbox."delivery_attempts",
          outbox."claim_count",
          outbox."abandoned_claim_count",
          candidates."was_abandoned",
          outbox."lock_token"
      `;

      for (const record of records) {
        if (record.was_abandoned) {
          await this.auditLog.record(
            {
              actorType: AuditActorType.SYSTEM,
              action: "AUTH.VERIFICATION_EMAIL_CLAIM_ABANDONED",
              targetType: "VerificationChallenge",
              targetId: record.challenge_id,
              outcome: "RECLAIMED",
              metadata: {
                claimCount: record.claim_count,
                abandonedClaimCount: record.abandoned_claim_count,
                attemptCount: record.delivery_attempts,
              },
            },
            transaction,
          );
        }
      }

      return records;
    });
  }

  private async deliver(record: ClaimedOutboxRecord): Promise<void> {
    try {
      const token = await this.prepareDelivery(record);
      if (token === undefined) {
        return;
      }

      const attemptNumber = await this.beginDeliveryAttempt(record);
      if (attemptNumber === undefined) {
        return;
      }

      await this.dispatchReservedAttempt(record, token, attemptNumber);
    } catch {
      this.logger.error(
        "Verification email outbox record processing failed; lease recovery will retry.",
      );
    }
  }

  private async prepareDelivery(
    record: ClaimedOutboxRecord,
  ): Promise<string | undefined> {
    return this.prisma.$transaction(async (transaction) => {
      const context = await this.loadDispatchContext(transaction, record);
      if (!context) {
        return undefined;
      }

      if (context.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) {
        await this.terminalize(transaction, record, "RETRIES_EXHAUSTED");
        return undefined;
      }

      let token: string;
      try {
        token = this.securityPrimitives.decryptOpaqueToken(
          {
            ciphertext: record.token_ciphertext,
            nonce: record.token_nonce,
            authTag: record.token_auth_tag,
          },
          this.encryptionKey,
        );
      } catch {
        await this.terminalize(transaction, record, "DECRYPTION_FAILED");
        return undefined;
      }

      try {
        this.emailDelivery.ensureAvailable();
      } catch (error) {
        await this.terminalize(
          transaction,
          record,
          error instanceof EmailDeliveryError
            ? error.code
            : "DELIVERY_INTERNAL_ERROR",
        );
        return undefined;
      }

      return token;
    });
  }

  private async loadDispatchContext(
    transaction: Prisma.TransactionClient,
    record: ClaimedOutboxRecord,
    attemptCount = record.delivery_attempts,
  ): Promise<
    | (DispatchContext & { readonly deliveryAttempts: number })
    | undefined
  > {
    const claimed = await transaction.$queryRaw<
      { readonly id: string; readonly delivery_attempts: number }[]
    >`
      SELECT "id", "delivery_attempts"
      FROM "verification_email_outbox"
      WHERE "id" = ${record.id}::uuid
        AND "lock_token" = ${record.lock_token}::uuid
        AND "delivered_at" IS NULL
        AND "failed_at" IS NULL
      FOR UPDATE
    `;

    if (!claimed[0]) {
      return undefined;
    }

    const challenges = await transaction.$queryRaw<LockedChallenge[]>`
      SELECT
        "id",
        "user_id",
        "purpose"::text AS "purpose",
        "expires_at",
        "consumed_at",
        ("expires_at" > NOW() + INTERVAL '10 seconds') AS "dispatchable"
      FROM "verification_challenges"
      WHERE "id" = ${record.challenge_id}::uuid
      FOR UPDATE
    `;
    const challenge = challenges[0];

    if (!challenge) {
      await this.terminalize(
        transaction,
        record,
        "CHALLENGE_NOT_FOUND",
        "VerificationEmailOutbox",
        record.id,
        attemptCount,
      );
      return undefined;
    }

    if (challenge.purpose !== VerificationChallengePurpose.EMAIL_VERIFICATION) {
      await this.terminalize(
        transaction,
        record,
        "WRONG_CHALLENGE_PURPOSE",
        "VerificationChallenge",
        record.challenge_id,
        attemptCount,
      );
      return undefined;
    }

    if (challenge.consumed_at !== null) {
      await this.terminalize(
        transaction,
        record,
        "CHALLENGE_CONSUMED",
        "VerificationChallenge",
        record.challenge_id,
        attemptCount,
      );
      return undefined;
    }

    if (!challenge.dispatchable) {
      await this.terminalize(
        transaction,
        record,
        "CHALLENGE_EXPIRED",
        "VerificationChallenge",
        record.challenge_id,
        attemptCount,
      );
      return undefined;
    }

    const users = await transaction.$queryRaw<LockedUser[]>`
      SELECT
        "id",
        "email",
        "status"::text AS "status",
        "email_verified_at"
      FROM "users"
      WHERE "id" = ${challenge.user_id}::uuid
      FOR UPDATE
    `;
    const user = users[0];

    if (
      !user ||
      user.status !== "PENDING_VERIFICATION" ||
      user.email_verified_at !== null
    ) {
      await this.terminalize(
        transaction,
        record,
        "ACCOUNT_NOT_PENDING",
        "VerificationChallenge",
        record.challenge_id,
        attemptCount,
      );
      return undefined;
    }

    const latestChallenges = await transaction.$queryRaw<
      { readonly id: string }[]
    >`
      SELECT "id"
      FROM "verification_challenges"
      WHERE "user_id" = ${user.id}::uuid
        AND "purpose" = ${VerificationChallengePurpose.EMAIL_VERIFICATION}::"verification_challenge_purpose"
      ORDER BY "created_at" DESC, "id" DESC
      LIMIT 1
    `;

    if (latestChallenges[0]?.id !== challenge.id) {
      await this.terminalize(
        transaction,
        record,
        "CHALLENGE_SUPERSEDED",
        "VerificationChallenge",
        record.challenge_id,
        attemptCount,
      );
      return undefined;
    }

    return {
      challenge,
      user,
      deliveryAttempts: claimed[0].delivery_attempts,
    };
  }

  private async beginDeliveryAttempt(
    record: ClaimedOutboxRecord,
  ): Promise<number | undefined> {
    const attempts = await this.prisma.$queryRaw<
      { readonly delivery_attempts: number }[]
    >`
      UPDATE "verification_email_outbox"
      SET
        "delivery_attempts" = "delivery_attempts" + 1,
        "last_delivery_attempt_lock_token" = "lock_token"
      WHERE "id" = ${record.id}::uuid
        AND "lock_token" = ${record.lock_token}::uuid
        AND "delivered_at" IS NULL
        AND "failed_at" IS NULL
        AND "delivery_attempts" < ${MAX_DELIVERY_ATTEMPTS}
        AND "last_delivery_attempt_lock_token" IS DISTINCT FROM "lock_token"
      RETURNING "delivery_attempts"
    `;

    return attempts[0]?.delivery_attempts;
  }

  private async dispatchReservedAttempt(
    record: ClaimedOutboxRecord,
    token: string,
    attemptNumber: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const context = await this.loadDispatchContext(
        transaction,
        record,
        attemptNumber,
      );
      if (!context) {
        return;
      }

      try {
        await this.emailDelivery.sendVerificationEmail({
          email: context.user.email,
          token,
          expiresAt: context.challenge.expires_at,
        });
      } catch (error) {
        await this.recordDeliveryFailure(
          transaction,
          record,
          attemptNumber,
          error instanceof EmailDeliveryError
            ? error
            : new EmailDeliveryError(
                "PERMANENT",
                "DELIVERY_INTERNAL_ERROR",
              ),
        );
        return;
      }

      await transaction.$executeRaw`
        UPDATE "verification_email_outbox"
        SET
          "delivered_at" = NOW(),
          "locked_at" = NULL,
          "lock_token" = NULL,
          "failed_at" = NULL,
          "failure_code" = NULL
        WHERE "id" = ${record.id}::uuid
          AND "lock_token" = ${record.lock_token}::uuid
      `;
      await this.auditLog.record(
        {
          actorType: AuditActorType.SYSTEM,
          action: "AUTH.VERIFICATION_EMAIL_PROVIDER_ACCEPTED",
          targetType: "VerificationChallenge",
          targetId: record.challenge_id,
          outcome: "SUCCESS",
          metadata: {
            challengePurpose:
              VerificationChallengePurpose.EMAIL_VERIFICATION,
            attemptCount: attemptNumber,
          },
        },
        transaction,
      );
    });
  }

  private async recordDeliveryFailure(
    transaction: Prisma.TransactionClient,
    record: ClaimedOutboxRecord,
    attemptNumber: number,
    error: EmailDeliveryError,
  ): Promise<void> {
    const retryable =
      error.kind === "TRANSIENT" || error.kind === "UNCERTAIN";
    const exhausted = attemptNumber >= MAX_DELIVERY_ATTEMPTS;

    if (!retryable || exhausted) {
      await this.terminalize(
        transaction,
        record,
        exhausted && retryable ? "RETRIES_EXHAUSTED" : error.code,
        "VerificationChallenge",
        record.challenge_id,
        attemptNumber,
      );
      return;
    }

    const retryDelaySeconds = calculateRetryDelaySeconds(attemptNumber);
    await transaction.$executeRaw`
      UPDATE "verification_email_outbox"
      SET
        "locked_at" = NULL,
        "lock_token" = NULL,
        "available_at" = NOW() + (${retryDelaySeconds} * INTERVAL '1 second'),
        "failed_at" = NULL,
        "failure_code" = ${error.code}
      WHERE "id" = ${record.id}::uuid
        AND "lock_token" = ${record.lock_token}::uuid
    `;
    await this.recordFailureAudit(
      transaction,
      record,
      error.code,
      "RETRYING",
      "VerificationChallenge",
      record.challenge_id,
      attemptNumber,
    );
    this.logger.warn("Verification email delivery failure scheduled for retry.");
  }

  private async terminalize(
    transaction: Prisma.TransactionClient,
    record: ClaimedOutboxRecord,
    failureCode: OutboxFailureCode,
    targetType = "VerificationChallenge",
    targetId = record.challenge_id,
    attemptCount = record.delivery_attempts,
  ): Promise<void> {
    const claimed = await transaction.$queryRaw<{ readonly id: string }[]>`
      SELECT "id"
      FROM "verification_email_outbox"
      WHERE "id" = ${record.id}::uuid
        AND "lock_token" = ${record.lock_token}::uuid
        AND "delivered_at" IS NULL
        AND "failed_at" IS NULL
      FOR UPDATE
    `;

    if (!claimed[0]) {
      return;
    }

    await transaction.$executeRaw`
      UPDATE "verification_email_outbox"
      SET
        "locked_at" = NULL,
        "lock_token" = NULL,
        "available_at" = NOW(),
        "failed_at" = NOW(),
        "failure_code" = ${failureCode}
      WHERE "id" = ${record.id}::uuid
        AND "lock_token" = ${record.lock_token}::uuid
    `;
    await this.recordFailureAudit(
      transaction,
      record,
      failureCode,
      "TERMINAL",
      targetType,
      targetId,
      attemptCount,
    );
    this.logger.warn("Verification email outbox record terminalized.");
  }

  private async recordFailureAudit(
    transaction: Prisma.TransactionClient,
    record: ClaimedOutboxRecord,
    failureCode: OutboxFailureCode,
    outcome: "RETRYING" | "TERMINAL",
    targetType = "VerificationChallenge",
    targetId = record.challenge_id,
    attemptCount = record.delivery_attempts,
  ): Promise<void> {
    await this.auditLog.record(
      {
        actorType: AuditActorType.SYSTEM,
        action: "AUTH.VERIFICATION_EMAIL_FAILED",
        targetType,
        targetId,
        outcome,
        metadata: {
          failureCode,
          attemptCount,
        },
      },
      transaction,
    );
  }
}
