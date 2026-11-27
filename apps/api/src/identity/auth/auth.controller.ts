import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthService } from "./auth.service.js";
import { RegisterDto } from "./dto/register.dto.js";
import { ResendVerificationDto } from "./dto/resend-verification.dto.js";
import { VerifyEmailDto } from "./dto/verify-email.dto.js";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ description: "Generic registration acknowledgement." })
  @ApiBadRequestResponse({ description: "Input validation failed." })
  @ApiServiceUnavailableResponse({ description: "Email delivery is unavailable." })
  async register(@Body() body: RegisterDto): Promise<{ message: string }> {
    await this.authService.register(body.email, body.password);
    return {
      message:
        "Request received. If registration can be completed and email delivery succeeds, verification instructions will arrive by email.",
    };
  }

  @Post("verify-email")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: "Email address verified." })
  @ApiBadRequestResponse({ description: "Token is invalid or expired." })
  async verifyEmail(
    @Body() body: VerifyEmailDto,
  ): Promise<{ message: string }> {
    await this.authService.verifyEmail(body.token);
    return { message: "Email verified." };
  }

  @Post("resend-verification")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({
    description: "Generic verification email request acknowledgement.",
  })
  @ApiBadRequestResponse({ description: "Input validation failed." })
  @ApiServiceUnavailableResponse({ description: "Email delivery is unavailable." })
  async resendVerification(
    @Body() body: ResendVerificationDto,
  ): Promise<{ message: string }> {
    await this.authService.resendVerification(body.email);
    return {
      message:
        "Request received. If an eligible account exists and email delivery succeeds, verification instructions will arrive by email.",
    };
  }
}
