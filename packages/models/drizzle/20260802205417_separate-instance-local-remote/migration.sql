CREATE TYPE "location" AS ENUM('Local', 'Remote');--> statement-breakpoint
CREATE TABLE "local_instances" (
	"id" uuid PRIMARY KEY,
	"slug" varchar(63) NOT NULL UNIQUE,
	"expires" timestamp with time zone NOT NULL,
	"maxActors" integer DEFAULT 10 NOT NULL,
	CONSTRAINT "instances_slug_check" CHECK ("slug" ~ '^[a-z0-9-]{4,63}$'),
	CONSTRAINT "instances_max_actors_check" CHECK ("maxActors" > 0)
);
--> statement-breakpoint
CREATE TABLE "remote_instances" (
	"id" uuid PRIMARY KEY,
	"host" varchar(100) NOT NULL UNIQUE,
	"nodeInfoUrl" text,
	"software" text,
	"softwareVersion" text
);
--> statement-breakpoint
ALTER TABLE "instances" DROP CONSTRAINT "instances_slug_key";--> statement-breakpoint
ALTER TABLE "instances" DROP CONSTRAINT "instances_slug_check";--> statement-breakpoint
ALTER TABLE "instances" DROP CONSTRAINT "instances_expires_check";--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "location" "location" NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" DROP COLUMN "slug";--> statement-breakpoint
ALTER TABLE "instances" DROP COLUMN "expires";--> statement-breakpoint
ALTER TABLE "local_instances" ADD CONSTRAINT "local_instances_id_instances_id_fkey" FOREIGN KEY ("id") REFERENCES "instances"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "remote_instances" ADD CONSTRAINT "remote_instances_id_instances_id_fkey" FOREIGN KEY ("id") REFERENCES "instances"("id") ON DELETE CASCADE;