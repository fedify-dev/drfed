ALTER TABLE "actors" DROP CONSTRAINT "username_key";--> statement-breakpoint
ALTER TABLE "activity_deliveries" ADD COLUMN "activity_id" uuid;--> statement-breakpoint
ALTER TABLE "actors" ALTER COLUMN "username" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "activity_delivery_activity_created_index" ON "activity_deliveries" ("activity_id","created" desc,"id" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "username_key" ON "actors" ("username","instance_id") WHERE "local_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_deliveries" ADD CONSTRAINT "activity_deliveries_activity_id_activities_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_local_username_check" CHECK ("local_id" IS NULL OR "username" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "actors" DROP CONSTRAINT "actors_username_check", ADD CONSTRAINT "actors_username_check" CHECK ("local_id" IS NULL OR "username" NOT LIKE '%@%');