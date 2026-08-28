-- CreateTable
CREATE TABLE "modules" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "is_core" BOOLEAN NOT NULL DEFAULT false,
    "dependencies" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "modules_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "organization_modules" (
    "organization_id" UUID NOT NULL,
    "module_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabled_at" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_modules_pkey" PRIMARY KEY ("organization_id","module_key")
);

-- CreateIndex
CREATE INDEX "organization_modules_organization_id_idx" ON "organization_modules"("organization_id");

-- AddForeignKey
ALTER TABLE "organization_modules" ADD CONSTRAINT "organization_modules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_modules" ADD CONSTRAINT "organization_modules_module_key_fkey" FOREIGN KEY ("module_key") REFERENCES "modules"("key") ON DELETE CASCADE ON UPDATE CASCADE;
