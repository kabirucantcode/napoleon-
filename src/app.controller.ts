import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  /**
   * Unauthenticated on purpose: a load balancer cannot hold a key, and knowing
   * whether the process is up should not require one.
   */
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'napoleon',
      time: new Date().toISOString(),
    };
  }
}
