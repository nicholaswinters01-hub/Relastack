-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- CreateTable
CREATE TABLE "plans" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "base_price_cents" INTEGER NOT NULL DEFAULT 0,
    "per_location_price_cents" INTEGER NOT NULL DEFAULT 0,
    "included_locations" INTEGER NOT NULL DEFAULT 1,
    "max_locations" INTEGER,
    "max_users" INTEGER,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "grace_period_days" INTEGER NOT NULL DEFAULT 14,
    "trial_days" INTEGER NOT NULL DEFAULT 14,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "plan_modules" (
    "plan_key" TEXT NOT NULL,
    "module_key" TEXT NOT NULL,

    CONSTRAINT "plan_modules_pkey" PRIMARY KEY ("plan_key","module_key")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_key" TEXT NOT NULL,
    "status" "subscription_status" NOT NULL DEFAULT 'TRIALING',
    "period_starts_at" TIMESTAMP(3) NOT NULL,
    "period_ends_at" TIMESTAMP(3) NOT NULL,
    "trial_ends_at" TIMESTAMP(3),
    "grace_ends_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "provider_customer_id" TEXT,
    "provider_subscription_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_add_ons" (
    "subscription_id" UUID NOT NULL,
    "module_key" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_add_ons_pkey" PRIMARY KEY ("subscription_id","module_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organization_id_key" ON "subscriptions"("organization_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "subscriptions_grace_ends_at_idx" ON "subscriptions"("grace_ends_at");

-- CreateIndex
CREATE INDEX "subscription_add_ons_organization_id_idx" ON "subscription_add_ons"("organization_id");

-- AddForeignKey
ALTER TABLE "plan_modules" ADD CONSTRAINT "plan_modules_plan_key_fkey" FOREIGN KEY ("plan_key") REFERENCES "plans"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_modules" ADD CONSTRAINT "plan_modules_module_key_fkey" FOREIGN KEY ("module_key") REFERENCES "modules"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_key_fkey" FOREIGN KEY ("plan_key") REFERENCES "plans"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_add_ons" ADD CONSTRAINT "subscription_add_ons_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_add_ons" ADD CONSTRAINT "subscription_add_ons_module_key_fkey" FOREIGN KEY ("module_key") REFERENCES "modules"("key") ON DELETE CASCADE ON UPDATE CASCADE;
