-- Environments (the platform and resellers), the reseller administrator role, emails unique per
-- environment, and plan packages for resellers.
-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'RESELLER';

-- DropIndex
DROP INDEX "User_email_key";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "tenantId" TEXT NOT NULL DEFAULT 'platform';

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "maxUsers" INTEGER,
    "packageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- The platform environment, reached at the root of the domain. Every existing account belongs to
-- it, so the current administrators become platform administrators.
INSERT INTO "Tenant" ("id", "code", "name", "active", "updatedAt")
VALUES ('platform', NULL, 'Pedirr', true, CURRENT_TIMESTAMP);

-- CreateTable
CREATE TABLE "PlanPackage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_PlanToPlanPackage" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PlanToPlanPackage_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_code_key" ON "Tenant"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PlanPackage_name_key" ON "PlanPackage"("name");

-- CreateIndex
CREATE INDEX "_PlanToPlanPackage_B_index" ON "_PlanToPlanPackage"("B");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "PlanPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PlanToPlanPackage" ADD CONSTRAINT "_PlanToPlanPackage_A_fkey" FOREIGN KEY ("A") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PlanToPlanPackage" ADD CONSTRAINT "_PlanToPlanPackage_B_fkey" FOREIGN KEY ("B") REFERENCES "PlanPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

