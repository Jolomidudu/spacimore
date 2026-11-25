import { Test } from "@nestjs/testing";
import { AuditActorType } from "../src/generated/prisma/client.js";
import {
  AuditLogService,
  sanitizeAuditMetadata,
} from "../src/identity/audit/audit-log.service.js";
import {
  validateIdentitySecurityConfig,
} from "../src/identity/security/identity-security.config.js";
import { SecurityPrimitives } from "../src/identity/security/security-primitives.js";
import { PrismaService } from "../src/database/prisma.service.js";

describe("Identity security primitives", () => {
  let securityPrimitives: SecurityPrimitives;

  beforeEach(() => {
    securityPrimitives = new SecurityPrimitives();
  });

  it("generates 32 cryptographically random bytes", () => {
    const bytes = securityPrimitives.generateSecureRandomBytes();

    expect(bytes).toHaveLength(32);
  });

  it("generates an opaque base64url token containing 256 bits of randomness", () => {
    const token = securityPrimitives.generateOpaqueToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("generates distinct opaque tokens", () => {
    expect(securityPrimitives.generateOpaqueToken()).not.toBe(
      securityPrimitives.generateOpaqueToken(),
    );
  });

  it("produces a deterministic SHA-256 digest for an opaque token", () => {
    const token = securityPrimitives.generateOpaqueToken();
    const digest = securityPrimitives.digestOpaqueToken(token);

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(securityPrimitives.digestOpaqueToken(token)).toBe(digest);
  });

  it("produces different digests for different token inputs", () => {
    const first = securityPrimitives.generateOpaqueToken();
    const second = securityPrimitives.generateOpaqueToken();

    expect(securityPrimitives.digestOpaqueToken(first)).not.toBe(
      securityPrimitives.digestOpaqueToken(second),
    );
  });

  it("rejects empty or excessively long opaque token inputs", () => {
    expect(() => securityPrimitives.digestOpaqueToken("")).toThrow(
      "Opaque token must be a non-empty bounded string.",
    );
    expect(() =>
      securityPrimitives.digestOpaqueToken("x".repeat(4097)),
    ).toThrow("Opaque token must be a non-empty bounded string.");
  });
});

describe("Identity security configuration", () => {
  it("defaults to no trusted origins", () => {
    expect(validateIdentitySecurityConfig({})).toEqual({ trustedOrigins: [] });
  });

  it("accepts HTTPS origins and local HTTP development origins", () => {
    expect(
      validateIdentitySecurityConfig({
        AUTH_TRUSTED_ORIGINS: "https://shop.example, http://localhost:3000",
      }),
    ).toEqual({
      trustedOrigins: ["https://shop.example", "http://localhost:3000"],
    });
  });

  it.each([
    "https://shop.example/path",
    "http://shop.example",
    "https://user:password@shop.example",
    "https://shop.example?query=1",
    "https://shop.example,",
    "https://shop.example,https://shop.example",
  ])("rejects an unsafe or malformed origin list without echoing it", (value) => {
    let errorMessage = "";
    try {
      validateIdentitySecurityConfig({ AUTH_TRUSTED_ORIGINS: value });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "";
    }

    expect(errorMessage).toBeTruthy();
    expect(errorMessage).not.toContain(value);
  });
});

describe("Audit metadata sanitization", () => {
  it("keeps allowlisted values and drops secret or unknown fields", () => {
    const metadata = sanitizeAuditMetadata({
      reasonCode: "REFRESH_TOKEN_REUSE",
      resourceType: "AuthSession",
      resourceId: "123e4567-e89b-42d3-a456-426614174000",
      attemptCount: 2,
      password: "not-for-audit",
      accessToken: "not-for-audit",
      customField: { nested: "not-for-audit" },
    });

    expect(metadata).toEqual({
      reasonCode: "REFRESH_TOKEN_REUSE",
      resourceType: "AuthSession",
      resourceId: "123e4567-e89b-42d3-a456-426614174000",
      attemptCount: 2,
    });
  });

  it("drops invalid values and returns undefined when no safe fields remain", () => {
    expect(
      sanitizeAuditMetadata({
        reasonCode: "arbitrary free-form text",
        resourceId: "not-a-uuid",
        attemptCount: -1,
        nested: { safeLooking: true },
      }),
    ).toBeUndefined();
  });

  it("accepts empty metadata as no metadata", () => {
    expect(sanitizeAuditMetadata({})).toBeUndefined();
    expect(sanitizeAuditMetadata(undefined)).toBeUndefined();
  });
});

describe("AuditLogService", () => {
  function createMockPrisma() {
    const calls: unknown[] = [];

    return {
      calls,
      prisma: {
        auditLog: {
          create: async (args: unknown): Promise<unknown> => {
            calls.push(args);
            return {};
          },
        },
      },
    };
  }

  it("writes a sanitized USER event through Prisma create only", async () => {
    const mock = createMockPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditLogService,
        {
          provide: PrismaService,
          useValue: mock.prisma,
        },
      ],
    }).compile();
    const service = moduleRef.get(AuditLogService);

    await service.record({
      actorType: AuditActorType.USER,
      actorUserId: "123e4567-e89b-42d3-a456-426614174000",
      action: "AUTH.SESSION_REVOKED",
      targetType: "AuthSession",
      targetId: "123e4567-e89b-42d3-a456-426614174001",
      requestId: "req-123",
      outcome: "SUCCESS",
      metadata: {
        reasonCode: "SESSION_LOGOUT",
        refreshToken: "never-persist-this",
      },
    });

    expect(mock.calls).toEqual([
      {
        data: {
          actorType: AuditActorType.USER,
          actorUserId: "123e4567-e89b-42d3-a456-426614174000",
          action: "AUTH.SESSION_REVOKED",
          targetType: "AuthSession",
          targetId: "123e4567-e89b-42d3-a456-426614174001",
          requestId: "req-123",
          outcome: "SUCCESS",
          metadata: { reasonCode: "SESSION_LOGOUT" },
        },
      },
    ]);

    await moduleRef.close();
  });

  it("stores SYSTEM actors with a null user id", async () => {
    const mock = createMockPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditLogService,
        {
          provide: PrismaService,
          useValue: mock.prisma,
        },
      ],
    }).compile();
    const service = moduleRef.get(AuditLogService);

    await service.record({
      actorType: AuditActorType.SYSTEM,
      action: "SYSTEM.MAINTENANCE",
      targetType: "User",
      outcome: "SUCCESS",
    });

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({
      data: {
        actorType: AuditActorType.SYSTEM,
        actorUserId: null,
        action: "SYSTEM.MAINTENANCE",
        targetType: "User",
        targetId: null,
        requestId: null,
        outcome: "SUCCESS",
      },
    });

    await moduleRef.close();
  });

  it("rejects invalid event fields before calling Prisma", async () => {
    const mock = createMockPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditLogService,
        {
          provide: PrismaService,
          useValue: mock.prisma,
        },
      ],
    }).compile();
    const service = moduleRef.get(AuditLogService);

    await expect(
      service.record({
        actorType: AuditActorType.USER,
        actorUserId: "not-a-uuid",
        action: "AUTH.INVALID_EVENT",
        targetType: "AuthSession",
        outcome: "SUCCESS",
      }),
    ).rejects.toThrow("USER audit events require a valid actorUserId.");

    expect(mock.calls).toHaveLength(0);
    await moduleRef.close();
  });
});
