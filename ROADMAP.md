# Roadmap

Planned work beyond the current release. Items are not scheduled or committed to a date.

## Notifications

Pedirr currently delivers notifications through two providers:

- Email over SMTP
- Discord webhooks

Additional notification providers may be added in the future. Delivery is already isolated behind the `NotificationChannel` interface (`apps/server/src/notifications/channels.ts`), so a new provider needs its own channel implementation, encrypted settings and administrator configuration, while reusing the existing outbox, per-recipient delivery records and retry handling.
