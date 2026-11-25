import { registerAs } from "@nestjs/config";

export interface IdentitySecurityConfig {
  trustedOrigins: readonly string[];
}

export function validateIdentitySecurityConfig(
  environment: NodeJS.ProcessEnv,
): IdentitySecurityConfig {
  const configuredOrigins = environment.AUTH_TRUSTED_ORIGINS;

  if (configuredOrigins === undefined || configuredOrigins.trim() === "") {
    return { trustedOrigins: [] };
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

  return { trustedOrigins: normalizedOrigins };
}

export const identitySecurityConfig = registerAs(
  "identitySecurity",
  (): IdentitySecurityConfig => validateIdentitySecurityConfig(process.env),
);
