import * as argon2 from "argon2";
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  AuditActorType,
  Prisma,
  UserStatus,
  VerificationChallengePurpose,
} from "../../generated/prisma/client.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AuditLogService } from "../audit/audit-log.service.js";
import { EmailDeliveryUnavailableError } from "../email/email-delivery.js";
import { VerificationEmailOutboxService } from "../email/verification-email-outbox.service.js";
import { SecurityPrimitives } from "../security/security-primitives.js";

const VERIFICATION_LIFETIME_MS = 30 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const RESEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_CHALLENGES_PER_HOUR = 3;
const MAX_CHALLENGE_ATTEMPTS = 5;

type ResendOutcome = "ACCEPTED" | "NOT_ELIGIBLE" | "THROTTLED";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly securityPrimitives: SecurityPrimitives,
    private readonly emailOutbox: VerificationEmailOutboxService,
  ) {}

  async register(email: string, password: string): Promise<void> {
    this.ensureEmailDeliveryAvailable();
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
    });
    const token = this.securityPrimitives.generateOpaqueToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + VERIFICATION_LIFETIME_MS);

    try {
      await this.prisma.$transaction(async (transaction) => {
        const user = await transaction.user.create({
          data: {
            email,
            status: UserStatus.PENDING_VERIFICATION,
            passwordCredential: {
              create: {
                passwordHash,
                passwordChangedAt: now,
              },
            },
            verificationChallenges: {
              create: {
                purpose: VerificationChallengePurpose.EMAIL_VERIFICATION,
                tokenHash: this.securityPrimitives.digestOpaqueToken(token),
                expiresAt,
              },
            },
          },
          select: {
            id: true,
            verificationChallenges: {
              where: {
                purpose: VerificationChallengePurpose.EMAIL_VERIFICATION,
                tokenHash: this.securityPrimitives.digestOpaqueToken(token),
              },
              select: { id: true },
            },
          },
        });
        const challengeId = user.verificationChallenges[0]?.id;

        if (!challengeId) {
          throw new Error("Created verification challenge could not be loaded.");
        }

        await this.emailOutbox.enqueue(transaction, {
          challengeId,
          token,
        });
        await this.auditLog.record(
          {
            actorType: AuditActorType.SYSTEM,
            action: "AUTH.REGISTRATION_COMPLETED",
            targetType: "User",
            targetId: user.id,
            outcome: "SUCCESS",
          },
          transaction,
        );
        await this.auditLog.record(
          {
            actorType: AuditActorType.SYSTEM,
            action: "AUTH.VERIFICATION_EMAIL_REQUESTED",
            targetType: "VerificationChallenge",
            targetId: challengeId,
            outcome: "ACCEPTED",
            metadata: {
              challengePurpose:
                VerificationChallengePurpose.EMAIL_VERIFICATION,
            },
          },
          transaction,
        );

      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const existingUser = await this.prisma.user.findUnique({
          where: { email },
          select: { id: true },
        });

        if (!existingUser) {
          throw error;
        }

        await this.auditLog.record({
          actorType: AuditActorType.SYSTEM,
          action: "AUTH.REGISTRATION_DUPLICATE",
          targetType: "User",
          outcome: "IGNORED",
        });
        return;
      }

      throw error;
    }
  }

  async verifyEmail(token: string): Promise<void> {
    const tokenHash = this.securityPrimitives.digestOpaqueToken(token);

    await this.prisma.$transaction(async (transaction) => {
      const challenge = await transaction.verificationChallenge.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          purpose: true,
          expiresAt: true,
          consumedAt: true,
          attemptCount: true,
        },
      });
      const now = new Date();

      if (
        !challenge ||
        challenge.purpose !==
          VerificationChallengePurpose.EMAIL_VERIFICATION ||
        challenge.expiresAt <= now ||
        challenge.consumedAt !== null ||
        challenge.attemptCount >= MAX_CHALLENGE_ATTEMPTS
      ) {
        throw new BadRequestException(
          "Verification token is invalid or expired.",
        );
      }

      const consumed = await transaction.verificationChallenge.updateMany({
        where: {
          id: challenge.id,
          purpose: VerificationChallengePurpose.EMAIL_VERIFICATION,
          consumedAt: null,
          expiresAt: { gt: now },
          attemptCount: { lt: MAX_CHALLENGE_ATTEMPTS },
        },
        data: { consumedAt: now },
      });

      if (consumed.count !== 1) {
        throw new BadRequestException(
          "Verification token is invalid or expired.",
        );
      }

      const activated = await transaction.user.updateMany({
        where: {
          id: challenge.userId,
          status: UserStatus.PENDING_VERIFICATION,
          emailVerifiedAt: null,
        },
        data: {
          status: UserStatus.ACTIVE,
          emailVerifiedAt: now,
        },
      });

      if (activated.count !== 1) {
        throw new BadRequestException(
          "Verification token is invalid or expired.",
        );
      }

      await this.auditLog.record(
        {
          actorType: AuditActorType.USER,
          actorUserId: challenge.userId,
          action: "AUTH.EMAIL_VERIFIED",
          targetType: "User",
          targetId: challenge.userId,
          outcome: "SUCCESS",
        },
        transaction,
      );
    });
  }

  async resendVerification(email: string): Promise<void> {
    this.ensureEmailDeliveryAvailable();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (!user) {
      await this.auditLog.record({
        actorType: AuditActorType.SYSTEM,
        action: "AUTH.VERIFICATION_RESEND_REQUESTED",
        targetType: "User",
        outcome: "NOT_ELIGIBLE",
      });
      return;
    }

    const token = this.securityPrimitives.generateOpaqueToken();
    const now = new Date();
    const windowStart = new Date(now.getTime() - RESEND_WINDOW_MS);
    const expiresAt = new Date(now.getTime() + VERIFICATION_LIFETIME_MS);

    await this.prisma.$transaction(
      async (transaction): Promise<void> => {
        await transaction.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${user.id}::uuid FOR UPDATE`;

        const lockedUser = await transaction.user.findUnique({
          where: { id: user.id },
          select: { id: true, status: true, emailVerifiedAt: true },
        });

        if (
          !lockedUser ||
          lockedUser.status !== UserStatus.PENDING_VERIFICATION ||
          lockedUser.emailVerifiedAt !== null
        ) {
          await this.recordResendRequested(transaction, user.id, "NOT_ELIGIBLE");
          return;
        }

        const recentChallenges =
          await transaction.verificationChallenge.findMany({
            where: {
              userId: user.id,
              purpose: VerificationChallengePurpose.EMAIL_VERIFICATION,
              createdAt: { gte: windowStart },
            },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          });
        const latestChallenge = recentChallenges[0];
        const isCoolingDown =
          latestChallenge !== undefined &&
          now.getTime() - latestChallenge.createdAt.getTime() <
            RESEND_COOLDOWN_MS;

        if (
          isCoolingDown ||
          recentChallenges.length >= MAX_CHALLENGES_PER_HOUR
        ) {
          await this.recordResendRequested(transaction, user.id, "THROTTLED");
          return;
        }

        const challenge = await transaction.verificationChallenge.create({
          data: {
            userId: user.id,
            purpose: VerificationChallengePurpose.EMAIL_VERIFICATION,
            tokenHash: this.securityPrimitives.digestOpaqueToken(token),
            expiresAt,
          },
          select: { id: true },
        });

        await this.emailOutbox.enqueue(transaction, {
          challengeId: challenge.id,
          token,
        });
        await this.recordResendRequested(transaction, user.id, "ACCEPTED");
        await this.auditLog.record(
          {
            actorType: AuditActorType.SYSTEM,
            action: "AUTH.VERIFICATION_EMAIL_REQUESTED",
            targetType: "VerificationChallenge",
            targetId: challenge.id,
            outcome: "ACCEPTED",
            metadata: {
              challengePurpose:
                VerificationChallengePurpose.EMAIL_VERIFICATION,
            },
          },
          transaction,
        );

      },
    );
  }

  private async recordResendRequested(
    transaction: Prisma.TransactionClient,
    userId: string,
    outcome: ResendOutcome,
  ): Promise<void> {
    await this.auditLog.record(
      {
        actorType: AuditActorType.SYSTEM,
        action: "AUTH.VERIFICATION_RESEND_REQUESTED",
        targetType: "User",
        targetId: userId,
        outcome,
      },
      transaction,
    );
  }

  private ensureEmailDeliveryAvailable(): void {
    try {
      this.emailOutbox.ensureAvailable();
    } catch (error) {
      if (error instanceof EmailDeliveryUnavailableError) {
        throw new ServiceUnavailableException(
          "Email delivery is temporarily unavailable.",
        );
      }
      throw error;
    }
  }

  private isUniqueViolation(
    error: unknown,
  ): error is Prisma.PrismaClientKnownRequestError {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    ) {
      return false;
    }

    return true;
  }
}
