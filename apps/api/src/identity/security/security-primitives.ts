import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { Injectable } from "@nestjs/common";

const SECURE_RANDOM_BYTE_LENGTH = 32;
const MAX_OPAQUE_TOKEN_LENGTH = 4096;
const AES_GCM_NONCE_LENGTH = 12;

export interface EncryptedSecret {
  readonly ciphertext: string;
  readonly nonce: string;
  readonly authTag: string;
}

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

  encryptOpaqueToken(token: string, key: Buffer): EncryptedSecret {
    if (key.length !== SECURE_RANDOM_BYTE_LENGTH) {
      throw new Error("Outbox encryption key must contain 32 bytes.");
    }

    const nonce = randomBytes(AES_GCM_NONCE_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(token, "utf8"),
      cipher.final(),
    ]);

    return {
      ciphertext: ciphertext.toString("base64url"),
      nonce: nonce.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    };
  }

  decryptOpaqueToken(
    encrypted: EncryptedSecret,
    key: Buffer,
  ): string {
    if (key.length !== SECURE_RANDOM_BYTE_LENGTH) {
      throw new Error("Outbox encryption key must contain 32 bytes.");
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(encrypted.nonce, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}
