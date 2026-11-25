import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./database/prisma.module.js";
import { HealthModule } from "./health/health.module.js";
import { IdentityModule } from "./identity/identity.module.js";
import { identitySecurityConfig } from "./identity/security/identity-security.config.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [identitySecurityConfig],
    }),
    PrismaModule,
    HealthModule,
    IdentityModule,
  ],
})
export class AppModule {}
