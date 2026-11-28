-- Each person's colour theme: dark (as before), light, or the system's.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "theme" TEXT NOT NULL DEFAULT 'dark';
