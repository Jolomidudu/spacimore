import { createHash, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";

const SECURE_RANDOM_BYTE_LENGTH = 32;
const MAX_OPAQUE_TOKEN_LENGTH = 4096;

@Injectable()
export class SecurityPrimitives {
  generateSecureRandomBytes(): Buffer {
    return randomBytes(SECURE_RANDOM_BYTE_LENGTH);
  }

  generateOpaqueToken(): string {
    return this.generateSecureRandomBytes().toString("base64url");
  }

  digestOpaqueToken(token: string): string {
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > MAX_OPAQUE_TOKEN_LENGTH
    ) {
      throw new Error("Opaque token must be a non-empty bounded string.");
    }

    return createHash("sha256").update(token, "utf8").digest("hex");
  }
}
