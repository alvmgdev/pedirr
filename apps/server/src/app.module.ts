import { UsersController, UsersService } from './users';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Infrastructure } from './infrastructure';
import { HealthController } from './health.controller';
import { AuthController, AuthService, SecurityGuard } from './auth';

@Module({ providers: [Infrastructure, AuthService, UsersService, { provide: APP_GUARD, useClass: SecurityGuard }], controllers: [HealthController, AuthController, UsersController] })
export class AppModule {}
