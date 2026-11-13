import { ServiceUnavailableException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Infrastructure } from "../infrastructure";
import { NotificationSettings } from "../settings/notifications";
import { DiscordChannel, EmailChannel, NotificationChannel, renderNotice } from "./channels";
import { errorCode } from "../jobs/fulfillment";
import { required } from "../config";

export class Notifications {
  constructor(
    private readonly infrastructure: Infrastructure,
    private readonly settings: NotificationSettings,
    private readonly email: NotificationChannel = new EmailChannel(),
    private readonly discord: NotificationChannel = new DiscordChannel(),
  ) {}
  async run(eventId: string) {
    const { db, redis } = this.infrastructure;
    const event = await db.outboxEvent.findUnique({ where: { id: eventId } });
    if (!event || !["request.created", "request.status"].includes(event.type)) {
      return;
    }
    // Requests with parts address only the subscribers whose own status changed.
    const payload = event.payload as { requestId: string; status: string; userIds?: string[] };
    const request = await db.request.findUnique({
      where: { id: payload.requestId },
      include: {
        entity: true,
        subscribers: {
          where: {
            createdAt: { lte: event.createdAt },
            user: { active: true },
            ...(Array.isArray(payload.userIds) ? { userId: { in: payload.userIds } } : {}),
          },
          include: { user: { select: { email: true, locale: true } } },
        },
      },
    });
    if (!request) {
      return;
    }
    const config = await this.settings.configuration();
    const scope = request.scope as { kind: string; season?: { name: string } };
    const title =
      request.entity.title + (scope.kind === "season" ? ` · ${scope.season?.name ?? ""}` : "");
    const url = `${new URL(required("APP_ORIGIN")).origin}/requests/${request.id}`;
    const deliveries: { channel: "email" | "discord"; recipient: string; locale: string }[] = [];
    if (config.emailEnabled && event.createdAt >= new Date(config.emailSince)) {
      const users = request.subscribers.map((subscription) => subscription.user);
      if (event.type === "request.created") {
        users.push(
          ...(await db.user.findMany({
            where: { active: true, role: "ADMIN" },
            select: { email: true, locale: true },
          })),
        );
      }
      const recipients = new Map(users.map((user) => [user.email, user.locale]));
      for (const [recipient, locale] of recipients) {
        deliveries.push({ channel: "email", recipient, locale });
      }
    }
    if (config.discordEnabled && event.createdAt >= new Date(config.discordSince)) {
      deliveries.push({
        channel: "discord",
        recipient: createHash("sha256").update(config.discordWebhook).digest("hex"),
        locale: config.discordLocale,
      });
    }
    let failure: unknown;
    for (const target of deliveries) {
      const record = await db.notificationDelivery.upsert({
        where: {
          eventId_channel_recipient: {
            eventId,
            channel: target.channel,
            recipient: target.recipient,
          },
        },
        create: { eventId, channel: target.channel, recipient: target.recipient },
        update: {},
      });
      if (record.status === "sent") {
        continue;
      }
      const key = `pedirr:delivery:${record.id}`;
      const owner = randomUUID();
      if (!(await redis.set(key, owner, "EX", 90, "NX"))) {
        failure = new ServiceUnavailableException({ code: "DELIVERY_BUSY", retryAfterSeconds: 90 });
        continue;
      }
      try {
        // Recheck after taking the lease: another worker may have completed before it was acquired.
        if (
          (await db.notificationDelivery.findUnique({ where: { id: record.id } }))?.status ===
          "sent"
        ) {
          continue;
        }
        await db.notificationDelivery.update({
          where: { id: record.id },
          data: { status: "sending", attempts: { increment: 1 }, lastError: null },
        });
        await (target.channel === "email" ? this.email : this.discord).send(
          config,
          target.recipient,
          renderNotice(target.locale, title, payload.status, url),
          record.id,
        );
        await db.notificationDelivery.update({
          where: { id: record.id },
          data: { status: "sent", lastError: null },
        });
      } catch (error) {
        await db.notificationDelivery.update({
          where: { id: record.id },
          data: { status: "failed", lastError: errorCode(error) },
        });
        failure ??= error;
      } finally {
        await redis.eval(
          `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`,
          1,
          key,
          owner,
        );
      }
    }
    if (failure) {
      throw failure;
    }
  }
}
