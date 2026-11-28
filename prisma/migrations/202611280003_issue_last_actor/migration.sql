-- Who acted last on an issue, so each side knows when it is waiting for them.
-- CreateEnum
CREATE TYPE "IssueActor" AS ENUM ('ADMIN', 'REPORTER');

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "lastActor" "IssueActor" NOT NULL DEFAULT 'REPORTER';

-- Existing issues: the author of their latest comment, when an administrator wrote it.
UPDATE "Issue" AS issue
SET "lastActor" = 'ADMIN'
FROM (
  SELECT DISTINCT ON (comment."issueId") comment."issueId", author."role"
  FROM "IssueComment" AS comment
  JOIN "User" AS author ON author."id" = comment."authorId"
  ORDER BY comment."issueId", comment."createdAt" DESC, comment."id" DESC
) AS latest
WHERE latest."issueId" = issue."id" AND latest."role" = 'ADMIN';

-- CreateIndex
CREATE INDEX "Issue_status_lastActor_updatedAt_idx" ON "Issue"("status", "lastActor", "updatedAt");
