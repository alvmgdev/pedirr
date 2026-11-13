-- Event parts per request, per subscriber and per synchronized event.
ALTER TABLE "Request" ADD COLUMN "closed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "RequestSubscriber"
  ADD COLUMN "parts" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "status" "RequestStatus" NOT NULL DEFAULT 'PENDING';

-- Existing subscribers asked for the whole event and share the request status.
UPDATE "RequestSubscriber" AS s SET "status" = r."status" FROM "Request" AS r WHERE r."id" = s."requestId";

ALTER TABLE "RequestEvent"
  ADD COLUMN "parts" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "availableParts" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "downloadingParts" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "downloading" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "RequestPart" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RequestPart_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RequestPart_requestId_name_key" ON "RequestPart"("requestId", "name");

ALTER TABLE "RequestPart" ADD CONSTRAINT "RequestPart_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;
