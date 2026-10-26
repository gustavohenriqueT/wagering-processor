import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { HttpResponse } from '../api/http';
import { ReadinessService } from '../api/readiness.service';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(HealthService) private readonly health: HealthService,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
  ) {}

  /** Processo vivo. Não toca em nenhuma dependência. */
  @Get('live')
  live() {
    return this.health.live();
  }

  /** Dependências alcançáveis. 503 quando alguma está fora, para o orquestrador tirar a instância do ar. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: HttpResponse) {
    const report = await this.readiness.check();
    response.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
