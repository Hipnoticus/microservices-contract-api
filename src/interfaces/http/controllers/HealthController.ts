import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { status: 'UP', service: 'contract-service' };
  }

  @Get('actuator/health')
  actuatorHealth() {
    return { status: 'UP', service: 'contract-service' };
  }
}
