-- Notification deliveries record the environment whose settings sent them.
-- DropIndex
DROP INDEX "NotificationDelivery_eventId_channel_recipient_key";

-- AlterTable
ALTER TABLE "NotificationDelivery" ADD COLUMN     "tenantId" TEXT NOT NULL DEFAULT 'platform';

-- CreateIndex
CREATE INDEX "NotificationDelivery_tenantId_createdAt_idx" ON "NotificationDelivery"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_eventId_channel_recipient_tenantId_key" ON "NotificationDelivery"("eventId", "channel", "recipient", "tenantId");

