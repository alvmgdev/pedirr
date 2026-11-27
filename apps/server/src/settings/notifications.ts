import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Injectable,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { randomInt } from "node:crypto";
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
import { TELEGRAM_TOKEN, telegramClient } from "../notifications/telegram";

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
  @ApiProperty({ required: false, description: "Post notices to the linked Telegram chat." })
  @ValidateIf((_, v) => v !== undefined)
  @IsBoolean()
  telegramEnabled?: boolean;
  @ApiProperty({ required: false, enum: ["en", "es"] })
  @ValidateIf((_, v) => v !== undefined)
  @IsIn(["en", "es"])
  telegramLocale?: "en" | "es";
  @ApiProperty({
    required: false,
    writeOnly: true,
    description: "The platform's bot token from @BotFather; platform only. Empty removes it.",
  })
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @MaxLength(256)
  telegramToken?: string;
}
type Telegram = {
  telegramEnabled: boolean;
  telegramLocale: "en" | "es";
  telegramChatId: string | null;
  telegramChatTitle: string | null;
  telegramSince: string;
};
export type NotificationConfig = Omit<
  NotificationInput,
  "smtpPassword" | "discordWebhook" | "telegramEnabled" | "telegramLocale" | "telegramToken"
> &
  Telegram & {
    smtpPassword: string;
    discordWebhook: string;
    /** The platform's bot token; empty for resellers, who post with the platform's bot. */
    telegramToken: string;
    emailSince: string;
    discordSince: string;
  };
type Stored = Omit<NotificationConfig, "smtpPassword" | "discordWebhook" | "telegramToken"> & {
  encryptedPassword: string | null;
  encryptedWebhook: string | null;
  // The platform's bot only: its encrypted token and its @username.
  encryptedTelegramToken: string | null;
  telegramBot: string | null;
};
/** One-time codes linking a Telegram chat, posted there as "/link CODE". */
const LINK_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const TELEGRAM_LINK_SECONDS = 1800;
export const telegramLinkKey = (code: string) => `pedirr:telegram:link:${code}`;
/** Environments with an unused code, scored by when it expires; the bot is read only meanwhile. */
export const TELEGRAM_PENDING = "pedirr:telegram:pending";
/** An environment's current code, so a new one replaces it. */
const codeKey = (tenantId: string) => `pedirr:telegram:code:${tenantId}`;
const telegramNotConfigured = () =>
  new BadRequestException({
    code: "TELEGRAM_NOT_CONFIGURED",
    message: "The platform has not set up a Telegram bot yet",
  });
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
  /** How the bot token is checked with Telegram; replaced in tests. */
  telegram = telegramClient;
  constructor(private readonly infrastructure: Infrastructure) {}
  private async stored(tenantId: string): Promise<Stored> {
    const row = await this.infrastructure.db.setting.findUnique({
      where: { key: settingKey(tenantId) },
    });
    const now = new Date().toISOString();
    // Settings saved before Telegram existed take its defaults.
    return {
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
      emailSince: now,
      discordSince: now,
      telegramEnabled: false,
      telegramLocale: "en",
      telegramChatId: null,
      telegramChatTitle: null,
      telegramSince: now,
      encryptedTelegramToken: null,
      telegramBot: null,
      ...(row?.value as Partial<Stored> | undefined),
    };
  }
  private async write(tenantId: string, value: Stored) {
    const key = settingKey(tenantId);
    await this.infrastructure.db.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
  /** The platform bot's @username, which every environment posts with. */
  private async bot() {
    return (await this.stored(PLATFORM_TENANT)).telegramBot;
  }
  async publicSettings(tenantId = PLATFORM_TENANT) {
    const {
      encryptedPassword,
      encryptedWebhook,
      encryptedTelegramToken,
      telegramBot,
      telegramChatId,
      telegramChatTitle,
      ...settings
    } = await this.stored(tenantId);
    return {
      ...settings,
      hasSmtpPassword: Boolean(encryptedPassword),
      hasDiscordWebhook: Boolean(encryptedWebhook),
      hasTelegramToken: Boolean(encryptedTelegramToken),
      telegramBot: tenantId === PLATFORM_TENANT ? telegramBot : await this.bot(),
      telegramChat: telegramChatId ? { title: telegramChatTitle ?? telegramChatId } : null,
      telegramLinkPending: Boolean(await this.infrastructure.redis.exists(codeKey(tenantId))),
    };
  }
  async configuration(tenantId = PLATFORM_TENANT): Promise<NotificationConfig> {
    const { encryptedPassword, encryptedWebhook, encryptedTelegramToken, ...settings } =
      await this.stored(tenantId);
    return {
      ...settings,
      smtpPassword: encryptedPassword
        ? this.box.decrypt(encryptedPassword, secretContext("smtp.password", tenantId))
        : "",
      discordWebhook: encryptedWebhook
        ? this.box.decrypt(encryptedWebhook, secretContext("discord.webhook", tenantId))
        : "",
      telegramToken: encryptedTelegramToken
        ? this.box.decrypt(encryptedTelegramToken, "telegram.token")
        : "",
    };
  }
  /** Checks a bot token with Telegram and returns the bot's @username. */
  private async checkToken(token: string) {
    const invalid = () =>
      new BadRequestException({
        code: "TELEGRAM_TOKEN_INVALID",
        message: "Telegram did not accept this bot token",
      });
    if (!TELEGRAM_TOKEN.test(token)) {
      throw invalid();
    }
    try {
      return (await this.telegram(token).getMe()).username;
    } catch (error) {
      const code =
        error instanceof HttpException && (error.getResponse() as { code?: string }).code;
      throw code === "TELEGRAM_TOKEN_INVALID" ? invalid() : error;
    }
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
    if (tenantId !== PLATFORM_TENANT && input.telegramToken !== undefined) {
      throw new BadRequestException({
        code: "TELEGRAM_TOKEN_PLATFORM_ONLY",
        message: "Only the platform sets the Telegram bot",
      });
    }
    const { smtpPassword, discordWebhook, telegramToken, ...publicValues } = input;
    let { encryptedTelegramToken, telegramBot } = previous;
    if (telegramToken !== undefined) {
      const token = telegramToken.trim();
      telegramBot = token ? await this.checkToken(token) : null;
      encryptedTelegramToken = token ? this.box.encrypt(token, "telegram.token") : null;
    }
    const telegramEnabled = input.telegramEnabled ?? previous.telegramEnabled;
    if (telegramEnabled && !(tenantId === PLATFORM_TENANT ? telegramBot : await this.bot())) {
      throw telegramNotConfigured();
    }
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
    await this.write(tenantId, {
      ...publicValues,
      encryptedPassword,
      encryptedWebhook,
      emailSince: input.emailEnabled && !previous.emailEnabled ? now : previous.emailSince,
      discordSince: input.discordEnabled && !previous.discordEnabled ? now : previous.discordSince,
      // The linked chat changes only through linking.
      telegramEnabled,
      telegramLocale: input.telegramLocale ?? previous.telegramLocale,
      telegramChatId: previous.telegramChatId,
      telegramChatTitle: previous.telegramChatTitle,
      telegramSince: telegramEnabled && !previous.telegramEnabled ? now : previous.telegramSince,
      encryptedTelegramToken: tenantId === PLATFORM_TENANT ? encryptedTelegramToken : null,
      telegramBot: tenantId === PLATFORM_TENANT ? telegramBot : null,
    });
    return this.publicSettings(tenantId);
  }
  /**
   * A one-time code to post as "/link CODE" in the group or channel to link, where the platform's
   * bot must already be an administrator. A new code replaces the environment's previous one.
   */
  async startTelegramLink(tenantId = PLATFORM_TENANT) {
    const bot = await this.bot();
    if (!bot) {
      throw telegramNotConfigured();
    }
    const redis = this.infrastructure.redis;
    const previous = await redis.get(codeKey(tenantId));
    if (previous) {
      await redis.del(telegramLinkKey(previous));
    }
    const code = Array.from(
      { length: 8 },
      () => LINK_ALPHABET[randomInt(LINK_ALPHABET.length)],
    ).join("");
    await redis.set(telegramLinkKey(code), tenantId, "EX", TELEGRAM_LINK_SECONDS);
    await redis.set(codeKey(tenantId), code, "EX", TELEGRAM_LINK_SECONDS);
    await redis.zadd(TELEGRAM_PENDING, Date.now() + TELEGRAM_LINK_SECONDS * 1000, tenantId);
    return { code, bot, expiresInSeconds: TELEGRAM_LINK_SECONDS };
  }
  /** Records the chat where an environment's code was posted. */
  async linkTelegram(tenantId: string, chat: { id: string; title: string }) {
    const previous = await this.stored(tenantId);
    await this.write(tenantId, {
      ...previous,
      telegramChatId: chat.id,
      telegramChatTitle: chat.title,
    });
    await this.infrastructure.redis.del(codeKey(tenantId));
    await this.infrastructure.redis.zrem(TELEGRAM_PENDING, tenantId);
  }
  async unlinkTelegram(tenantId = PLATFORM_TENANT) {
    const previous = await this.stored(tenantId);
    await this.write(tenantId, { ...previous, telegramChatId: null, telegramChatTitle: null });
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
  @Post("telegram/link") startTelegramLink() {
    return this.settings.startTelegramLink();
  }
  @Delete("telegram/link") unlinkTelegram() {
    return this.settings.unlinkTelegram();
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
  @Post("telegram/link") startTelegramLink(@Req() req: AuthRequest) {
    return this.settings.startTelegramLink(req.viewer!.tenantId);
  }
  @Delete("telegram/link") unlinkTelegram(@Req() req: AuthRequest) {
    return this.settings.unlinkTelegram(req.viewer!.tenantId);
  }
}
