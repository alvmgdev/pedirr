ALTER TABLE "OutboxEvent" ADD COLUMN "processedAt" TIMESTAMP(3);
ALTER TABLE "OutboxEvent" ADD COLUMN "jobId" TEXT;
CREATE INDEX "OutboxEvent_processedAt_publishedAt_idx" ON "OutboxEvent"("processedAt", "publishedAt");
