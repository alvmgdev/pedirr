import { SportarrSettings, SportarrSettingsController } from './settings/sportarr';
import { RequestsController } from './requests/controller';
import { RequestsService } from './requests/service';
import { CatalogController } from './metadata/controller';
import { HubProvider } from './metadata/hub';
import { MetadataProvider } from './metadata/provider';
import { UsersController, UsersService } from './users';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Infrastructure } from './infrastructure';
import { HealthController } from './health.controller';
import { AuthController, AuthService, SecurityGuard } from './auth';

@Module({ providers: [{ provide: MetadataProvider, useClass: HubProvider }, Infrastructure, AuthService, UsersService, SportarrSettings, RequestsService, { provide: APP_GUARD, useClass: SecurityGuard }], controllers: [SportarrSettingsController, RequestsController, CatalogController, HealthController, AuthController, UsersController] })
export class AppModule {}
