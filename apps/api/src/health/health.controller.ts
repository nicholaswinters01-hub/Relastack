import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import type { HealthResponse } from '@platform/shared';
import { Public } from '../auth/auth.decorators';
import { HealthService } from './health.service';

/**
 * Health endpoints.
 *
 * Deliberately unauthenticated — load balancers and uptime monitors must be
 * able to reach them. They therefore expose no tenant or business data.
 *
 * `@Public()` is applied at the class level, so it covers every route here.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Full health report including dependency status.
   *
   * Returns 503 when a dependency is down so orchestrators and uptime monitors
   * react correctly, while still returning the detailed body — the caller needs
   * to know *what* is broken, not merely that something is.
   */
  @Get()
  async check(): Promise<HealthResponse> {
    const result = await this.healthService.check();

    if (result.status !== 'ok') {
      // Passing an object makes it the response body verbatim, so the contract
      // is identical whether the system is healthy or degraded.
      throw new ServiceUnavailableException(result);
    }

    return result;
  }

  /**
   * Liveness probe: is the process running at all?
   *
   * Intentionally does NOT check the database. A liveness probe that fails on
   * database trouble causes orchestrators to restart healthy processes, turning
   * a recoverable outage into a restart loop.
   */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
