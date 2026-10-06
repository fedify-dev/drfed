ALTER TABLE "activities" RENAME COLUMN "actorId" TO "actor_id";--> statement-breakpoint
ALTER TABLE "activities" RENAME COLUMN "objectId" TO "object_id";--> statement-breakpoint
ALTER TABLE "actor_collection_references" RENAME COLUMN "actorId" TO "actor_id";--> statement-breakpoint
ALTER TABLE "actor_collection_references" RENAME COLUMN "collectionId" TO "collection_id";--> statement-breakpoint
ALTER TABLE "actors" RENAME COLUMN "localId" TO "local_id";--> statement-breakpoint
ALTER TABLE "actors" RENAME COLUMN "instanceId" TO "instance_id";--> statement-breakpoint
ALTER TABLE "actors" RENAME COLUMN "inboxUrl" TO "inbox_url";--> statement-breakpoint
ALTER TABLE "actors" RENAME COLUMN "profileUrl" TO "profile_url";--> statement-breakpoint
ALTER TABLE "actors" RENAME COLUMN "avatarUrl" TO "avatar_url";--> statement-breakpoint
ALTER TABLE "actors" RENAME COLUMN "headerUrl" TO "header_url";--> statement-breakpoint
ALTER TABLE "actors" RENAME COLUMN "bioHtml" TO "bio_html";--> statement-breakpoint
ALTER TABLE "actors" RENAME COLUMN "automaticallyApprovesFollowers" TO "automatically_approves_followers";--> statement-breakpoint
ALTER TABLE "actors" RENAME COLUMN "fieldHtmls" TO "field_htmls";--> statement-breakpoint
ALTER TABLE "actors" RENAME COLUMN "suspendedUntil" TO "suspended_until";--> statement-breakpoint
ALTER TABLE "actors" RENAME COLUMN "successorId" TO "successor_id";--> statement-breakpoint
ALTER TABLE "actors" RENAME COLUMN "followingCount" TO "following_count";--> statement-breakpoint
ALTER TABLE "actors" RENAME COLUMN "followersCount" TO "followers_count";--> statement-breakpoint
ALTER TABLE "addressing" RENAME COLUMN "sourceId" TO "source_id";--> statement-breakpoint
ALTER TABLE "addressing" RENAME COLUMN "targetId" TO "target_id";--> statement-breakpoint
ALTER TABLE "collection_items" RENAME COLUMN "collectionId" TO "collection_id";--> statement-breakpoint
ALTER TABLE "collection_items" RENAME COLUMN "itemId" TO "item_id";--> statement-breakpoint
ALTER TABLE "collections" RENAME COLUMN "ownerActorId" TO "owner_actor_id";--> statement-breakpoint
ALTER TABLE "collections" RENAME COLUMN "totalItems" TO "total_items";--> statement-breakpoint
ALTER TABLE "instance_members" RENAME COLUMN "accountId" TO "account_id";--> statement-breakpoint
ALTER TABLE "instance_members" RENAME COLUMN "instanceId" TO "instance_id";--> statement-breakpoint
ALTER TABLE "instances" RENAME COLUMN "localId" TO "local_id";--> statement-breakpoint
ALTER TABLE "instances" RENAME COLUMN "nodeInfoUrl" TO "node_info_url";--> statement-breakpoint
ALTER TABLE "instances" RENAME COLUMN "softwareVersion" TO "software_version";--> statement-breakpoint
ALTER TABLE "local_instances" RENAME COLUMN "maxActors" TO "max_actors";--> statement-breakpoint
ALTER TABLE "login_challenges" RENAME COLUMN "accountId" TO "account_id";--> statement-breakpoint
ALTER TABLE "objects" RENAME COLUMN "actorId" TO "actor_id";--> statement-breakpoint
ALTER TABLE "objects" RENAME COLUMN "contentHtml" TO "content_html";--> statement-breakpoint
ALTER TABLE "sessions" RENAME COLUMN "accountId" TO "account_id";--> statement-breakpoint
ALTER TABLE "sessions" RENAME COLUMN "tokenHash" TO "token_hash";--> statement-breakpoint
ALTER TABLE "actors" DROP CONSTRAINT "actors_suspended_check", ADD CONSTRAINT "actors_suspended_check" CHECK (
        "suspended_until" IS NULL OR (
          "suspended" IS NOT NULL AND
          "suspended_until" > "suspended"
        )
      );--> statement-breakpoint
ALTER TABLE "local_instances" DROP CONSTRAINT "instances_max_actors_check", ADD CONSTRAINT "instances_max_actors_check" CHECK ("max_actors" > 0);--> statement-breakpoint
ALTER TABLE "objects" DROP CONSTRAINT "objects_content_html_check", ADD CONSTRAINT "objects_content_html_check" CHECK (trim(both from "content_html") <> '');
