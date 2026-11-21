import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { HealthService } from "./health.service.js";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: "Check API health" })
  @ApiOkResponse({
    description: "The API is running.",
    schema: {
      example: { status: "ok" },
    },
  })
  getHealth(): { status: string } {
    return this.healthService.getStatus();
  }
}
