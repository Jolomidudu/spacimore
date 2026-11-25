import { Module } from "@nestjs/common";
import { AuditLogService } from "./audit/audit-log.service.js";
import { SecurityPrimitives } from "./security/security-primitives.js";

@Module({
  providers: [AuditLogService, SecurityPrimitives],
  exports: [AuditLogService, SecurityPrimitives],
})
export class IdentityModule {}
