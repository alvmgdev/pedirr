CREATE TABLE "RequestEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "remoteId" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "available" BOOLEAN NOT NULL DEFAULT false,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "checkedAt" TIMESTAMP(3),
    CONSTRAINT "RequestEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RequestEvent_requestId_externalId_key" ON "RequestEvent"("requestId", "externalId");
ALTER TABLE "RequestEvent" ADD CONSTRAINT "RequestEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;
