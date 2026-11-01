import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Infrastructure } from './infrastructure';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly infrastructure: Infrastructure) {}

  @Get('live')
  live() { return { status: 'ok', service: 'pedirr-api' }; }

  @Get('ready')
  async ready() {
    try {
      await Promise.all([
        this.infrastructure.db.$queryRaw`SELECT 1`,
        this.infrastructure.redis.ping(),
      ]);
      const heartbeat = await this.infrastructure.redis.get('pedirr:worker:heartbeat');
      if (!heartbeat || Date.now() - Number(heartbeat) > 60000) throw new Error('Worker unavailable');
      return { status: 'ok', database: 'ok', queue: 'ok', worker: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
  }
}
