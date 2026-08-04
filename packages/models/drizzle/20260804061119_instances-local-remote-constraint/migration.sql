ALTER TABLE "local_instances" ADD COLUMN "location" "location" DEFAULT 'Local'::"location" NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_instances" ADD COLUMN "location" "location" DEFAULT 'Remote'::"location" NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_id_location_key" UNIQUE("id","location");--> statement-breakpoint
ALTER TABLE "local_instances" ADD CONSTRAINT "local_instance_fk" FOREIGN KEY ("id","location") REFERENCES "instances"("id","location") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "remote_instances" ADD CONSTRAINT "remote_instance_fk" FOREIGN KEY ("id","location") REFERENCES "instances"("id","location") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "local_instances" ADD CONSTRAINT "local_check" CHECK ("location" = 'Local');--> statement-breakpoint
ALTER TABLE "remote_instances" ADD CONSTRAINT "remote_check" CHECK ("location" = 'Remote');