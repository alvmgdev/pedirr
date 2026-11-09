import { ServiceUnavailableException } from "@nestjs/common";
import nodemailer from "nodemailer";
import { NotificationConfig } from "../settings/notifications";
import { retrySeconds } from "../metadata/hub";

export type Notice = { subject: string; text: string; url: string };
export interface NotificationChannel {
  send(
    config: NotificationConfig,
    recipient: string,
    notice: Notice,
    deliveryId: string,
  ): Promise<void>;
}
export function renderNotice(locale: string, title: string, status: string, url: string): Notice {
  const labels: Record<string, Record<string, string>> = {
    en: {
      PENDING: "Pending approval",
      APPROVED: "Approved",
      REJECTED: "Rejected",
      DOWNLOADING: "Downloading",
      AVAILABLE: "Available",
    },
    es: {
      PENDING: "Pendiente de aprobación",
      APPROVED: "Aprobada",
      REJECTED: "Rechazada",
      DOWNLOADING: "Descargando",
      AVAILABLE: "Disponible",
    },
  };
  const label = (labels[locale] ?? labels.en)[status] ?? status;
  const subject = `Pedirr · ${label}`;
  return { subject, text: `${title}\n${label}\n${url}`, url };
}
export class EmailChannel implements NotificationChannel {
  async send(config: NotificationConfig, recipient: string, notice: Notice, deliveryId: string) {
    const transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecurity === "tls",
      requireTLS: config.smtpSecurity === "starttls",
      ignoreTLS: config.smtpSecurity === "plain",
      ...(config.smtpUser ? { auth: { user: config.smtpUser, pass: config.smtpPassword } } : {}),
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      const result = await transport.sendMail({
        from: config.emailFrom,
        to: recipient,
        subject: notice.subject,
        text: notice.text,
        messageId: `<${deliveryId}@pedirr.local>`,
      });
      if (!result.accepted.length || result.rejected.length) {
        throw new Error("SMTP rejected recipient");
      }
    } catch {
      throw new ServiceUnavailableException({
        code: "EMAIL_DELIVERY_FAILED",
        message: "Email delivery failed",
      });
    } finally {
      transport.close();
    }
  }
}
export class DiscordChannel implements NotificationChannel {
  async send(config: NotificationConfig, _recipient: string, notice: Notice) {
    const url = new URL(config.discordWebhook);
    url.searchParams.set("wait", "true");
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          content: `${notice.subject}\n${notice.text}`.slice(0, 2000),
          allowed_mentions: { parse: [] },
        }),
      });
    } catch {
      throw new ServiceUnavailableException({
        code: "DISCORD_DELIVERY_FAILED",
        message: "Discord delivery failed",
      });
    }
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const seconds =
        retry !== null && Number.isFinite(Number(retry))
          ? Math.max(1, Math.ceil(Number(retry)))
          : retrySeconds(retry);
      throw new ServiceUnavailableException({
        code: "DISCORD_RATE_LIMITED",
        message: "Discord rate limit reached",
        retryAfterSeconds: seconds,
      });
    }
    if (!response.ok) {
      throw new ServiceUnavailableException({
        code: "DISCORD_DELIVERY_FAILED",
        message: "Discord delivery failed",
      });
    }
  }
}
