ALTER TABLE "objects" ADD COLUMN "activity_id" uuid;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_activity_id_key" UNIQUE("activity_id");--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_activity_id_resources_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "resources"("id") ON DELETE SET NULL;