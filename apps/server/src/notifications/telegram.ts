import { ServiceUnavailableException } from "@nestjs/common";
import type { NotificationConfig } from "../settings/notifications";
import { Notice, NotificationChannel } from "./channels";

/** A bot token as @BotFather issues it: the bot's numeric ID, a colon and a secret. */
export const TELEGRAM_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;
type Chat = { id: number | string; title?: string; username?: string };
type Post = { text?: string; chat: Chat };
export type TelegramUpdate = { update_id: number; message?: Post; channel_post?: Post };

const failure = (code: string, retryAfterSeconds?: number) =>
  new ServiceUnavailableException({
    code,
    message: "Telegram did not accept the request",
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  });

/**
 * Telegram's Bot API. The token is part of every request URL, so errors carry only a code and
 * never the token or the response.
 */
export class TelegramApi {
  constructor(private readonly token: string) {}
  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify(body),
      });
    } catch {
      throw failure("TELEGRAM_UNREACHABLE");
    }
    const result = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      parameters?: { retry_after?: number };
    };
    if (response.status === 429) {
      throw failure("TELEGRAM_RATE_LIMITED", Math.max(1, result.parameters?.retry_after ?? 30));
    }
    if (response.status === 401 || response.status === 404) {
      throw failure("TELEGRAM_TOKEN_INVALID");
    }
    // The bot was removed from the group or channel, or may no longer post there.
    if (response.status === 403) {
      throw failure("TELEGRAM_FORBIDDEN");
    }
    if (!response.ok || !result.ok) {
      throw failure("TELEGRAM_DELIVERY_FAILED");
    }
    return result.result as T;
  }
  getMe() {
    return this.call<{ username: string }>("getMe", {});
  }
  /** Messages and channel posts after `offset`, without waiting for new ones. */
  getUpdates(offset?: number) {
    return this.call<TelegramUpdate[]>("getUpdates", {
      ...(offset ? { offset } : {}),
      timeout: 0,
      allowed_updates: ["message", "channel_post"],
    });
  }
  sendMessage(chatId: string, text: string) {
    return this.call<unknown>("sendMessage", {
      chat_id: chatId,
      text: text.slice(0, 4000),
      disable_web_page_preview: true,
    });
  }
}
export type TelegramClient = Pick<TelegramApi, "getMe" | "getUpdates" | "sendMessage">;
export const telegramClient = (token: string): TelegramClient => new TelegramApi(token);

/** Posts notices to a linked group or channel with the platform's bot. */
export class TelegramChannel implements NotificationChannel {
  constructor(private readonly client: (token: string) => TelegramClient = telegramClient) {}
  async send(config: NotificationConfig, recipient: string, notice: Notice) {
    await this.client(config.telegramToken).sendMessage(
      recipient,
      `${notice.subject}\n${notice.text}`,
    );
  }
}
