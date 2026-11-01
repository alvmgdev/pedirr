import { Module } from '@nestjs/common';
import { Infrastructure } from './infrastructure';
import { HealthController } from './health.controller';

@Module({ providers: [Infrastructure], controllers: [HealthController] })
export class AppModule {}
