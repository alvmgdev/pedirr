-- Optional weekly request limit and account expiration for users.
-- AlterTable
ALTER TABLE "User" ADD COLUMN "weeklyRequestLimit" INTEGER,
ADD COLUMN "expiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RequestSubscriber" ADD COLUMN "countsTowardQuota" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "RequestSubscriber_userId_createdAt_idx" ON "RequestSubscriber"("userId", "createdAt");

-- Requests a user started already count, so a limit set now covers the past seven days.
UPDATE "RequestSubscriber" AS s
SET "countsTowardQuota" = true
FROM "RequestHistory" AS h
WHERE h."requestId" = s."requestId"
  AND h."actorId" = s."userId"
  AND h."action" = 'created';
