import { Module } from "@nestjs/common";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService } from "./auth/auth.service.js";
import { AuditLogService } from "./audit/audit-log.service.js";
import { EMAIL_DELIVERY } from "./email/email-delivery.js";
import { ResendEmailDeliveryService } from "./email/resend-email-delivery.service.js";
import { VerificationEmailOutboxService } from "./email/verification-email-outbox.service.js";
import { SecurityPrimitives } from "./security/security-primitives.js";

@Module({
  controllers: [AuthController],
  providers: [
    AuditLogService,
    AuthService,
    SecurityPrimitives,
    ResendEmailDeliveryService,
    VerificationEmailOutboxService,
    { provide: EMAIL_DELIVERY, useExisting: ResendEmailDeliveryService },
  ],
  exports: [AuditLogService, SecurityPrimitives],
})
export class IdentityModule {}
