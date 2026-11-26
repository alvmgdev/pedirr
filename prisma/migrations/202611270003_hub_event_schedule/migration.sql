-- Local copy of Hub's schedule (7 days back to 14 ahead), for paging and filtering by plan.
-- CreateTable
CREATE TABLE "HubEvent" (
    "id" TEXT NOT NULL,
    "shortId" TEXT,
    "name" TEXT NOT NULL,
    "leagueId" TEXT,
    "seasonId" TEXT,
    "homeTeamId" TEXT,
    "homeTeamName" TEXT,
    "awayTeamId" TEXT,
    "awayTeamName" TEXT,
    "scheduledStart" TIMESTAMP(3),
    "status" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "item" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HubEvent_scheduledStart_idx" ON "HubEvent"("scheduledStart");

-- CreateIndex
CREATE INDEX "HubEvent_leagueId_scheduledStart_idx" ON "HubEvent"("leagueId", "scheduledStart");

-- CreateIndex
CREATE INDEX "HubEvent_syncedAt_idx" ON "HubEvent"("syncedAt");

