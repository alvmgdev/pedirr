-- Whole-season requests become an explicit grant; existing users start with single events only.
ALTER TABLE "User" ADD COLUMN "canRequestSeasons" BOOLEAN NOT NULL DEFAULT false;
