import { Infrastructure } from "../infrastructure";
import { NotificationSettings, TELEGRAM_PENDING, telegramLinkKey } from "../settings/notifications";
import { TelegramClient, telegramClient, TelegramUpdate } from "../notifications/telegram";

export const TELEGRAM_POLL_JOB = "telegram-poll";
export const TELEGRAM_POLL_EVERY_MS = 5000;
const OFFSET = "pedirr:telegram:offset";
const LOCK = "pedirr:telegram:poll";
/** "/link CODE", also as "/link@BotName CODE" in groups with several bots. */
const LINK = /^\/link(?:@\w+)?\s+([A-Za-z0-9]{6,12})\s*$/;
/** Telegram returns at most 100 updates at a time; a run catches up on this many pages. */
const PAGE = 100;
const PAGES = 10;

/**
 * Reads what reached the platform's bot and links the chats where an environment's code was
 * posted. The bot is read only while some environment has an unused code, which lasts at most
 * TELEGRAM_LINK_SECONDS; the rest of the time a run is one Redis lookup. Telegram keeps updates
 * until they are confirmed with the next offset, so a failed run picks them up again; a lock keeps
 * two workers from reading the same updates.
 */
export async function pollTelegram(
  infrastructure: Infrastructure,
  settings: NotificationSettings,
  client: (token: string) => TelegramClient = telegramClient,
) {
  const redis = infrastructure.redis;
  await redis.zremrangebyscore(TELEGRAM_PENDING, "-inf", Date.now());
  if (!(await redis.zcard(TELEGRAM_PENDING))) {
    return { skipped: "nothing_to_link" as const };
  }
  const { telegramToken } = await settings.configuration();
  if (!telegramToken) {
    return { skipped: "not_configured" as const };
  }
  if (!(await redis.set(LOCK, "1", "EX", 30, "NX"))) {
    return { skipped: "running" as const };
  }
  try {
    const bot = client(telegramToken);
    let read = 0;
    let linked = 0;
    for (let page = 0; page < PAGES; page++) {
      const updates = await bot.getUpdates(Number(await redis.get(OFFSET)) || undefined);
      for (const update of updates) {
        linked += (await link(update)) ? 1 : 0;
      }
      // Confirmed only once handled: the next request with this offset tells Telegram to drop them.
      if (updates.length) {
        await redis.set(OFFSET, String(updates[updates.length - 1].update_id + 1));
      }
      read += updates.length;
      if (updates.length < PAGE) {
        break;
      }
    }
    return { updates: read, linked };

    async function link(update: TelegramUpdate) {
      const post = update.message ?? update.channel_post;
      const code = LINK.exec(post?.text?.trim() ?? "")?.[1]?.toUpperCase();
      const tenantId = code ? await redis.get(telegramLinkKey(code)) : null;
      if (!post || !code || !tenantId) {
        return false;
      }
      const chat = post.chat;
      await settings.linkTelegram(tenantId, {
        id: String(chat.id),
        title: chat.title ?? (chat.username ? `@${chat.username}` : String(chat.id)),
      });
      await redis.del(telegramLinkKey(code));
      // A confirmation in the chat itself; linking stands even if it cannot be posted.
      await bot
        .sendMessage(
          String(chat.id),
          "Pedirr: linked. Notices will be posted here. / Vinculado: los avisos se publicarán aquí.",
        )
        .catch(() => undefined);
      return true;
    }
  } finally {
    await redis.del(LOCK);
  }
}
