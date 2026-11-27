import { jest } from "@jest/globals";
import { ConfigService } from "@nestjs/config";
import {
  EmailDeliveryError,
  EmailDeliveryUnavailableError,
} from "../src/identity/email/email-delivery.js";
import { ResendEmailDeliveryService } from "../src/identity/email/resend-email-delivery.service.js";

const message = {
  email: "person@example.com",
  token: "test-token",
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
};

function createService(configured = true): ResendEmailDeliveryService {
  return new ResendEmailDeliveryService({
    get: (key: string) => {
      if (!configured) {
        return undefined;
      }
      return key === "RESEND_API_KEY" ? "test-api-key" : "test@example.com";
    },
  } as unknown as ConfigService);
}

describe("ResendEmailDeliveryService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("classifies rate limits, timeouts and server errors as transient", async () => {
    for (const status of [408, 425, 429, 500, 503]) {
      jest
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(null, { status }));

      await expect(
        createService().sendVerificationEmail(message),
      ).rejects.toMatchObject({
        kind: "TRANSIENT",
        code: "PROVIDER_TRANSIENT",
      });

      jest.restoreAllMocks();
    }
  });

  it("classifies credential rejection as a configuration failure", async () => {
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("sensitive provider response", { status: 401 }));

    await expect(
      createService().sendVerificationEmail(message),
    ).rejects.toMatchObject({
      kind: "CONFIGURATION",
      code: "PROVIDER_AUTHENTICATION",
    });
  });

  it("classifies other client errors as permanent without exposing the response", async () => {
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("sensitive provider response", { status: 422 }));

    let deliveryError: unknown;
    try {
      await createService().sendVerificationEmail(message);
    } catch (error) {
      deliveryError = error;
    }

    expect(deliveryError).toBeInstanceOf(EmailDeliveryError);
    expect(deliveryError).toMatchObject({
      kind: "PERMANENT",
      code: "PROVIDER_REJECTED",
    });
    expect((deliveryError as Error).message).not.toContain(
      "sensitive provider response",
    );
  });

  it("uses the provider error type to distinguish retryable and permanent conflicts", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { name: "resource_locked", message: "sensitive provider response" },
        { status: 409 },
      ),
    );

    await expect(
      createService().sendVerificationEmail(message),
    ).rejects.toMatchObject({
      kind: "TRANSIENT",
      code: "PROVIDER_TRANSIENT",
    });

    jest.restoreAllMocks();
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          name: "invalid_idempotent_request",
          message: "sensitive provider response",
        },
        { status: 409 },
      ),
    );

    await expect(
      createService().sendVerificationEmail(message),
    ).rejects.toMatchObject({
      kind: "PERMANENT",
      code: "PROVIDER_REJECTED",
    });
  });

  it("treats a transport failure as an uncertain delivery outcome", async () => {
    jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("sensitive transport details"));

    await expect(
      createService().sendVerificationEmail(message),
    ).rejects.toMatchObject({
      kind: "UNCERTAIN",
      code: "DELIVERY_UNCERTAIN",
    });
  });

  it("reports missing provider configuration without making a request", () => {
    const fetch = jest.spyOn(globalThis, "fetch");

    expect(() => createService(false).ensureAvailable()).toThrow(
      EmailDeliveryUnavailableError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a successful provider response", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 202 }),
    );

    await expect(
      createService().sendVerificationEmail(message),
    ).resolves.toBeUndefined();
  });
});
