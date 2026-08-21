CREATE TYPE "actor_type" AS ENUM('Application', 'Group', 'Organization', 'Person', 'Service');--> statement-breakpoint
CREATE TABLE "actors" (
	"id" uuid PRIMARY KEY,
	"localId" uuid UNIQUE,
	"type" "actor_type" NOT NULL,
	"username" text NOT NULL,
	"instanceId" uuid NOT NULL,
	"iri" text NOT NULL UNIQUE,
	"inboxUrl" text NOT NULL,
	"outboxUrl" text NOT NULL,
	"followersUrl" text,
	"followeesUrl" text,
	"featuredUrl" text,
	"profileUrl" text,
	"avatarUrl" text,
	"headerUrl" text,
	"name" text,
	"bioHtml" text,
	"automaticallyApprovesFollowers" boolean DEFAULT false NOT NULL,
	"fieldHtmls" jsonb DEFAULT '{}' NOT NULL,
	"emojis" jsonb DEFAULT '{}' NOT NULL,
	"tags" jsonb DEFAULT '{}' NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"suspended" timestamp with time zone,
	"suspendedUntil" timestamp with time zone,
	"successorId" uuid,
	"aliases" text[] DEFAULT (ARRAY[]::text[])::text[] NOT NULL,
	"followeesCount" integer DEFAULT 0 NOT NULL,
	"followersCount" integer DEFAULT 0 NOT NULL,
	"postsCount" integer DEFAULT 0 NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"published" timestamp with time zone,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted" timestamp with time zone,
	CONSTRAINT "username_key" UNIQUE("username","instanceId"),
	CONSTRAINT "actors_username_check" CHECK ("username" NOT LIKE '%@%'),
	CONSTRAINT "actors_suspended_check" CHECK (
        "suspendedUntil" IS NULL OR (
          "suspended" IS NOT NULL AND
          "suspendedUntil" > "suspended"
        )
      )
);
--> statement-breakpoint
CREATE TABLE "local_actors" (
	"id" uuid PRIMARY KEY,
	"avatar" text,
	"header" text
);
--> statement-breakpoint
CREATE INDEX "actor_instance_index" ON "actors" ("instanceId");--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_localId_local_actors_id_fkey" FOREIGN KEY ("localId") REFERENCES "local_actors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_instanceId_instances_id_fkey" FOREIGN KEY ("instanceId") REFERENCES "instances"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_successorId_actors_id_fkey" FOREIGN KEY ("successorId") REFERENCES "actors"("id") ON DELETE SET NULL;