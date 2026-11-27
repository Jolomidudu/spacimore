import { registerAs } from "@nestjs/config";

export interface IdentitySecurityConfig {
  trustedOrigins: readonly string[];
  outboxEncryptionKey: Buffer;
}

export function validateIdentitySecurityConfig(
  environment: NodeJS.ProcessEnv,
): IdentitySecurityConfig {
  const encryptionKey = environment.EMAIL_OUTBOX_ENCRYPTION_KEY;

  if (!encryptionKey) {
    throw new Error("EMAIL_OUTBOX_ENCRYPTION_KEY must be configured.");
  }

  const outboxEncryptionKey = Buffer.from(encryptionKey, "base64");

  if (
    outboxEncryptionKey.length !== 32 ||
    outboxEncryptionKey.toString("base64") !== encryptionKey
  ) {
    throw new Error(
      "EMAIL_OUTBOX_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    );
  }

  const configuredOrigins = environment.AUTH_TRUSTED_ORIGINS;

  if (configuredOrigins === undefined || configuredOrigins.trim() === "") {
    return { trustedOrigins: [], outboxEncryptionKey };
  }

  const origins = configuredOrigins.split(",").map((value) => value.trim());

  if (origins.some((origin) => origin.length === 0)) {
    throw new Error("AUTH_TRUSTED_ORIGINS contains an empty origin.");
  }

  const normalizedOrigins = origins.map((origin) => {
    let parsedOrigin: URL;

    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new Error("AUTH_TRUSTED_ORIGINS must contain valid origins.");
    }

    const isLocalHttp =
      parsedOrigin.protocol === "http:" &&
      (parsedOrigin.hostname === "localhost" ||
        parsedOrigin.hostname === "127.0.0.1" ||
        parsedOrigin.hostname === "[::1]");
    const hasSafeProtocol =
      parsedOrigin.protocol === "https:" || isLocalHttp;
    const isOriginOnly =
      parsedOrigin.origin === origin &&
      parsedOrigin.username.length === 0 &&
      parsedOrigin.password.length === 0 &&
      parsedOrigin.search.length === 0 &&
      parsedOrigin.hash.length === 0;

    if (!hasSafeProtocol || !isOriginOnly) {
      throw new Error(
        "AUTH_TRUSTED_ORIGINS must contain HTTPS origins (HTTP is allowed only for localhost) without paths or credentials.",
      );
    }

    return parsedOrigin.origin;
  });

  if (new Set(normalizedOrigins).size !== normalizedOrigins.length) {
    throw new Error("AUTH_TRUSTED_ORIGINS must not contain duplicates.");
  }

  return { trustedOrigins: normalizedOrigins, outboxEncryptionKey };
}

export const identitySecurityConfig = registerAs(
  "identitySecurity",
  (): IdentitySecurityConfig => validateIdentitySecurityConfig(process.env),
);
