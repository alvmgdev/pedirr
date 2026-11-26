-- Whole seasons are requested by administrators only, so the per-user grant goes away.
-- Season requests users made before keep being fulfilled.
-- AlterTable
ALTER TABLE "User" DROP COLUMN "canRequestSeasons";
