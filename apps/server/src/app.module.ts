import { ApiExceptionFilter } from "./errors";
import { Availability } from "./requests/availability";
import { NotificationSettings, NotificationSettingsController } from "./settings/notifications";
import { SportarrSettings, SportarrSettingsController } from "./settings/sportarr";
import { RequestsController } from "./requests/controller";
import { RequestsService } from "./requests/service";
import { CatalogController } from "./metadata/controller";
import { HubProvider } from "./metadata/hub";
import { MetadataProvider } from "./metadata/provider";
import { UsersController, UsersService } from "./users";
import { IssuesController } from "./issues/controller";
import { IssuesService } from "./issues/service";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { Infrastructure } from "./infrastructure";
import { HealthController } from "./health.controller";
import { AuthController, AuthService, SecurityGuard } from "./auth";

@Module({
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: MetadataProvider, useClass: HubProvider },
    Infrastructure,
    AuthService,
    UsersService,
    SportarrSettings,
    NotificationSettings,
    RequestsService,
    IssuesService,
    Availability,
    { provide: APP_GUARD, useClass: SecurityGuard },
  ],
  controllers: [
    NotificationSettingsController,
    SportarrSettingsController,
    RequestsController,
    IssuesController,
    CatalogController,
    HealthController,
    AuthController,
    UsersController,
  ],
})
export class AppModule {}
