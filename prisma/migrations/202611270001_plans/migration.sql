-- Plans: content packages choosing which sports and leagues users may request.
-- CreateEnum
CREATE TYPE "PlanGrantKind" AS ENUM ('SPORT', 'LEAGUE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "planId" TEXT;

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "allContent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanGrant" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "kind" "PlanGrantKind" NOT NULL,
    "hubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "PlanGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_name_key" ON "Plan"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PlanGrant_planId_kind_hubId_key" ON "PlanGrant"("planId", "kind", "hubId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanGrant" ADD CONSTRAINT "PlanGrant_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
