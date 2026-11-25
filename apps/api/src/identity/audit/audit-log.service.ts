import { Injectable } from "@nestjs/common";
import { AuditActorType, Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../database/prisma.service.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_CODE_PATTERN = /^[A-Z][A-Z0-9_.:-]{0,127}$/;
const TARGET_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const OUTCOME_PATTERN = /^[A-Z][A-Z0-9_.:-]{0,63}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const SAFE_METADATA_VALUES = {
  reasonCode: [
    "ACCOUNT_SUSPENDED",
    "ACCOUNT_UNVERIFIED",
    "CHALLENGE_ALREADY_CONSUMED",
    "CHALLENGE_EXPIRED",
    "INVALID_CREDENTIALS",
    "LOGOUT_ALL",
    "PASSWORD_CHANGED",
    "REFRESH_TOKEN_REUSE",
    "SESSION_LOGOUT",
    "STAFF_ROLE_GRANTED",
    "STAFF_ROLE_REVOKED",
  ],
  resourceType: [
    "AuthSession",
    "Business",
    "BusinessMembership",
    "PasswordCredential",
    "Permission",
    "RefreshToken",
    "Role",
    "User",
    "UserRole",
    "VerificationChallenge",
  ],
  roleCode: [
    "ADMIN",
    "CUSTOMER_SUPPORT",
    "OPERATIONS",
    "SUPER_ADMIN",
  ],
  challengePurpose: ["EMAIL_VERIFICATION", "PASSWORD_RESET"],
} as const;

type AuditMetadataInput = Readonly<Record<string, unknown>>;
type SafeAuditMetadata = Prisma.InputJsonObject;

function isAllowedValue<T extends readonly string[]>(
  value: string,
  allowedValues: T,
): value is T[number] {
  return allowedValues.some((allowedValue) => allowedValue === value);
}

interface AuditEventBase {
  action: string;
  targetType: string;
  targetId?: string | null;
  requestId?: string | null;
  outcome: string;
  metadata?: AuditMetadataInput | null;
}

export type AuditEvent =
  | (AuditEventBase & {
      actorType: typeof AuditActorType.USER;
      actorUserId: string;
    })
  | (AuditEventBase & {
      actorType: typeof AuditActorType.SYSTEM;
      actorUserId?: null;
    });

export function sanitizeAuditMetadata(
  metadata: AuditMetadataInput | null | undefined,
): SafeAuditMetadata | undefined {
  if (metadata === undefined || metadata === null) {
    return undefined;
  }

  const sanitized: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (key === "resourceId" || key === "businessId" || key === "sessionId") {
      if (typeof value === "string" && UUID_PATTERN.test(value)) {
        sanitized[key] = value;
      }
      continue;
    }

    if (key === "attemptCount") {
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      ) {
        sanitized[key] = value;
      }
      continue;
    }

    if (
      key === "reasonCode" &&
      typeof value === "string" &&
      isAllowedValue(value, SAFE_METADATA_VALUES.reasonCode)
    ) {
      sanitized[key] = value;
      continue;
    }

    if (
      key === "resourceType" &&
      typeof value === "string" &&
      isAllowedValue(value, SAFE_METADATA_VALUES.resourceType)
    ) {
      sanitized[key] = value;
      continue;
    }

    if (
      key === "roleCode" &&
      typeof value === "string" &&
      isAllowedValue(value, SAFE_METADATA_VALUES.roleCode)
    ) {
      sanitized[key] = value;
      continue;
    }

    if (
      key === "challengePurpose" &&
      typeof value === "string" &&
      isAllowedValue(value, SAFE_METADATA_VALUES.challengePurpose)
    ) {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length > 0
    ? sanitized
    : undefined;
}

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    event: AuditEvent,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    this.validateEvent(event);

    const client = transaction ?? this.prisma;
    const metadata = sanitizeAuditMetadata(event.metadata);

    await client.auditLog.create({
      data: {
        actorType: event.actorType,
        actorUserId:
          event.actorType === AuditActorType.USER ? event.actorUserId : null,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId ?? null,
        requestId: event.requestId ?? null,
        outcome: event.outcome,
        ...(metadata === undefined ? {} : { metadata }),
      },
    });
  }

  private validateEvent(event: AuditEvent): void {
    if (
      !EVENT_CODE_PATTERN.test(event.action) ||
      !TARGET_TYPE_PATTERN.test(event.targetType) ||
      !OUTCOME_PATTERN.test(event.outcome)
    ) {
      throw new Error("Audit event contains an invalid code or target type.");
    }

    if (
      event.targetId !== undefined &&
      event.targetId !== null &&
      !UUID_PATTERN.test(event.targetId)
    ) {
      throw new Error("Audit targetId must be a UUID.");
    }

    if (
      event.requestId !== undefined &&
      event.requestId !== null &&
      !REQUEST_ID_PATTERN.test(event.requestId)
    ) {
      throw new Error("Audit requestId contains invalid characters.");
    }

    if (
      event.actorType === AuditActorType.USER &&
      !UUID_PATTERN.test(event.actorUserId)
    ) {
      throw new Error("USER audit events require a valid actorUserId.");
    }
  }
}
