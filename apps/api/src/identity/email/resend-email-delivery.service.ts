import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  EmailDeliveryError,
  EmailDeliveryUnavailableError,
} from "./email-delivery.js";
import type { VerificationEmail } from "./email-delivery.js";

@Injectable()
export class ResendEmailDeliveryService {
  constructor(private readonly configService: ConfigService) {}

  ensureAvailable(): void {
    if (!this.getConfiguration()) {
      throw new EmailDeliveryUnavailableError(
        "CONFIGURATION",
        "PROVIDER_CONFIGURATION",
      );
    }
  }

  async sendVerificationEmail(message: VerificationEmail): Promise<void> {
    const configuration = this.getConfiguration();

    if (!configuration) {
      throw new EmailDeliveryUnavailableError(
        "CONFIGURATION",
        "PROVIDER_CONFIGURATION",
      );
    }

    let response: Response;

    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${configuration.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          from: configuration.sender,
          to: [message.email],
          subject: "Verify your Spacimore email",
          text: [
            "Use this verification token to verify your Spacimore email:",
            message.token,
            "",
            `This token expires at ${message.expiresAt.toISOString()}.`,
            "Submit it to POST /api/v1/auth/verify-email.",
          ].join("\n"),
        }),
      });
    } catch {
      throw new EmailDeliveryUnavailableError(
        "UNCERTAIN",
        "DELIVERY_UNCERTAIN",
      );
    }

    if (response.ok) {
      return;
    }

    if (response.status === 401 || response.status === 403) {
      throw new EmailDeliveryUnavailableError(
        "CONFIGURATION",
        "PROVIDER_AUTHENTICATION",
      );
    }

    if (
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      throw new EmailDeliveryUnavailableError(
        "TRANSIENT",
        "PROVIDER_TRANSIENT",
      );
    }

    if (response.status === 409) {
      const providerErrorType = await this.getProviderErrorType(response);
      if (
        providerErrorType === "concurrent_idempotent_requests" ||
        providerErrorType === "resource_locked"
      ) {
        throw new EmailDeliveryUnavailableError(
          "TRANSIENT",
          "PROVIDER_TRANSIENT",
        );
      }
    }

    throw new EmailDeliveryError("PERMANENT", "PROVIDER_REJECTED");
  }

  private async getProviderErrorType(
    response: Response,
  ): Promise<string | undefined> {
    try {
      const body: unknown = await response.json();

      if (typeof body !== "object" || body === null) {
        return undefined;
      }

      const type =
        "name" in body
          ? body.name
          : "type" in body
            ? body.type
            : undefined;
      return typeof type === "string" ? type : undefined;
    } catch {
      return undefined;
    }
  }

  private getConfiguration():
    | { readonly apiKey: string; readonly sender: string }
    | undefined {
    const apiKey = this.configService.get<string>("RESEND_API_KEY")?.trim();
    const sender = this.configService.get<string>("EMAIL_FROM")?.trim();

    if (!apiKey || !sender) {
      return undefined;
    }

    return { apiKey, sender };
  }
}
