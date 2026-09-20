-- AlterTable
ALTER TABLE "identity"."addresses" ALTER COLUMN "province_code" DROP NOT NULL;

-- AlterTable
ALTER TABLE "identity"."users" ADD COLUMN     "google_sub" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "users_google_sub_key" ON "identity"."users"("google_sub");

