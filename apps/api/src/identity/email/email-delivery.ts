export const EMAIL_DELIVERY = Symbol("EMAIL_DELIVERY");

export interface VerificationEmail {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface EmailDelivery {
  ensureAvailable(): void;
  sendVerificationEmail(message: VerificationEmail): Promise<void>;
}

export type EmailDeliveryFailureKind =
  | "TRANSIENT"
  | "PERMANENT"
  | "CONFIGURATION"
  | "UNCERTAIN";

export type EmailDeliveryFailureCode =
  | "PROVIDER_CONFIGURATION"
  | "PROVIDER_AUTHENTICATION"
  | "PROVIDER_REJECTED"
  | "PROVIDER_TRANSIENT"
  | "DELIVERY_UNCERTAIN"
  | "DELIVERY_INTERNAL_ERROR";

export class EmailDeliveryError extends Error {
  constructor(
    readonly kind: EmailDeliveryFailureKind,
    readonly code: EmailDeliveryFailureCode,
  ) {
    super("Email delivery failed.");
    this.name = "EmailDeliveryError";
  }
}

export class EmailDeliveryUnavailableError extends EmailDeliveryError {
  constructor(
    kind: "TRANSIENT" | "CONFIGURATION" | "UNCERTAIN" = "TRANSIENT",
    code: EmailDeliveryFailureCode = "PROVIDER_TRANSIENT",
  ) {
    super(kind, code);
    this.name = "EmailDeliveryUnavailableError";
  }
}
