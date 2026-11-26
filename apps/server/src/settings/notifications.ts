import { BadRequestException, Body, Controller, Get, Injectable, Put, Req } from "@nestjs/common";
import { ApiProperty } from "@nestjs/swagger";
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";
import { Admin, AuthRequest, ResellerAdmin } from "../auth";
import { Infrastructure } from "../infrastructure";
import { PLATFORM_TENANT } from "../tenants";
import { SecretBox } from "./secrets";

/**
 * Each environment has its own notification settings. The platform keeps the original key and
 * secret contexts, so settings saved before resellers existed still decrypt; a reseller's are
 * bound to its ID, so one reseller's secrets never decrypt as another's.
 */
const settingKey = (tenantId: string) =>
  tenantId === PLATFORM_TENANT ? "notifications" : `notifications:${tenantId}`;
const secretContext = (name: string, tenantId: string) =>
  tenantId === PLATFORM_TENANT ? name : `${name}:${tenantId}`;

export class NotificationInput {
  @ApiProperty() @IsBoolean() emailEnabled!: boolean;
  @ApiProperty() @IsString() @MaxLength(253) smtpHost!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(65535) smtpPort!: number;
  @ApiProperty({ enum: ["tls", "starttls", "plain"] })
  @IsIn(["tls", "starttls", "plain"])
  smtpSecurity!: "tls" | "starttls" | "plain";
  @ApiProperty() @IsString() @MaxLength(254) smtpUser!: string;
  @ApiProperty({ required: false, writeOnly: true })
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @MaxLength(1024)
  smtpPassword?: string;
  @ApiProperty()
  @ValidateIf((o) => o.emailEnabled || o.emailFrom !== "")
  @IsEmail()
  @MaxLength(254)
  emailFrom!: string;
  @ApiProperty() @IsBoolean() discordEnabled!: boolean;
  @ApiProperty({ required: false, writeOnly: true })
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @MaxLength(2048)
  discordWebhook?: string;
  @ApiProperty({ enum: ["en", "es"] }) @IsIn(["en", "es"]) discordLocale!: "en" | "es";
}
export type NotificationConfig = Omit<NotificationInput, "smtpPassword" | "discordWebhook"> & {
  smtpPassword: string;
  discordWebhook: string;
  emailSince: string;
  discordSince: string;
};
type Stored = Omit<NotificationConfig, "smtpPassword" | "discordWebhook"> & {
  encryptedPassword: string | null;
  encryptedWebhook: string | null;
};
export function discordUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "discord.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)
    ) {
      throw new Error();
    }
    return url.href;
  } catch {
    throw new BadRequestException({
      code: "INVALID_DISCORD_WEBHOOK",
      message: "Enter a Discord webhook URL",
    });
  }
}
@Injectable()
export class NotificationSettings {
  private readonly box = new SecretBox();
  constructor(private readonly infrastructure: Infrastructure) {}
  private async stored(tenantId: string): Promise<Stored> {
    const row = await this.infrastructure.db.setting.findUnique({
      where: { key: settingKey(tenantId) },
    });
    return row
      ? (row.value as unknown as Stored)
      : {
          emailEnabled: false,
          smtpHost: "",
          smtpPort: 587,
          smtpSecurity: "starttls",
          smtpUser: "",
          emailFrom: "",
          discordEnabled: false,
          discordLocale: "en",
          encryptedPassword: null,
          encryptedWebhook: null,
          emailSince: new Date().toISOString(),
          discordSince: new Date().toISOString(),
        };
  }
  async publicSettings(tenantId = PLATFORM_TENANT) {
    const { encryptedPassword, encryptedWebhook, ...settings } = await this.stored(tenantId);
    return {
      ...settings,
      hasSmtpPassword: Boolean(encryptedPassword),
      hasDiscordWebhook: Boolean(encryptedWebhook),
    };
  }
  async configuration(tenantId = PLATFORM_TENANT): Promise<NotificationConfig> {
    const { encryptedPassword, encryptedWebhook, ...settings } = await this.stored(tenantId);
    return {
      ...settings,
      smtpPassword: encryptedPassword
        ? this.box.decrypt(encryptedPassword, secretContext("smtp.password", tenantId))
        : "",
      discordWebhook: encryptedWebhook
        ? this.box.decrypt(encryptedWebhook, secretContext("discord.webhook", tenantId))
        : "",
    };
  }
  async save(input: NotificationInput, tenantId = PLATFORM_TENANT) {
    const previous = await this.stored(tenantId);
    if (input.emailEnabled && (!input.smtpHost || !/^[a-zA-Z0-9.-]+$/.test(input.smtpHost))) {
      throw new BadRequestException({
        code: "INVALID_SMTP_HOST",
        message: "Enter an SMTP hostname or IPv4 address",
      });
    }
    if (
      input.smtpPassword === undefined &&
      previous.encryptedPassword &&
      (input.smtpHost !== previous.smtpHost ||
        input.smtpUser !== previous.smtpUser ||
        input.smtpPort !== previous.smtpPort ||
        input.smtpSecurity !== previous.smtpSecurity)
    ) {
      throw new BadRequestException({
        code: "SMTP_PASSWORD_REQUIRED",
        message: "Provide a password when changing the SMTP connection",
      });
    }
    const { smtpPassword, discordWebhook, ...publicValues } = input;
    const encryptedPassword =
      smtpPassword === undefined
        ? previous.encryptedPassword
        : smtpPassword
          ? this.box.encrypt(smtpPassword, secretContext("smtp.password", tenantId))
          : null;
    const encryptedWebhook =
      discordWebhook === undefined
        ? previous.encryptedWebhook
        : discordWebhook
          ? this.box.encrypt(discordUrl(discordWebhook), secretContext("discord.webhook", tenantId))
          : null;
    if (input.discordEnabled && !encryptedWebhook) {
      throw new BadRequestException({
        code: "DISCORD_WEBHOOK_REQUIRED",
        message: "Provide a Discord webhook",
      });
    }
    const now = new Date().toISOString();
    const value = {
      ...publicValues,
      encryptedPassword,
      encryptedWebhook,
      emailSince: input.emailEnabled && !previous.emailEnabled ? now : previous.emailSince,
      discordSince: input.discordEnabled && !previous.discordEnabled ? now : previous.discordSince,
    };
    const key = settingKey(tenantId);
    await this.infrastructure.db.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    return this.publicSettings(tenantId);
  }
  deliveries(tenantId = PLATFORM_TENANT) {
    return this.infrastructure.db.notificationDelivery.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
}
@Admin()
@Controller("admin/settings/notifications")
export class NotificationSettingsController {
  constructor(private readonly settings: NotificationSettings) {}
  @Get() get() {
    return this.settings.publicSettings();
  }
  @Put() save(@Body() input: NotificationInput) {
    return this.settings.save(input);
  }
  @Get("deliveries") deliveries() {
    return this.settings.deliveries();
  }
}

/** A reseller's own notification settings, used for its administrator and clients only. */
@ResellerAdmin()
@Controller("reseller/notifications")
export class ResellerNotificationSettingsController {
  constructor(private readonly settings: NotificationSettings) {}
  @Get() get(@Req() req: AuthRequest) {
    return this.settings.publicSettings(req.viewer!.tenantId);
  }
  @Put() save(@Body() input: NotificationInput, @Req() req: AuthRequest) {
    return this.settings.save(input, req.viewer!.tenantId);
  }
  @Get("deliveries") deliveries(@Req() req: AuthRequest) {
    return this.settings.deliveries(req.viewer!.tenantId);
  }
}
