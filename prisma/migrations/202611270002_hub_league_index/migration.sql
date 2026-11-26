-- Daily index of Hub leagues and their sports, for filtering the catalog by plan.
-- CreateTable
CREATE TABLE "HubLeague" (
    "id" TEXT NOT NULL,
    "shortId" TEXT,
    "name" TEXT NOT NULL,
    "sportId" TEXT,
    "sportName" TEXT,
    "country" TEXT,
    "logoUrl" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubLeague_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HubLeague_sportId_idx" ON "HubLeague"("sportId");

-- CreateIndex
CREATE INDEX "HubLeague_syncedAt_idx" ON "HubLeague"("syncedAt");

