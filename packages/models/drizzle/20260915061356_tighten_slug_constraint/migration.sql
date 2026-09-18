-- A slug becomes the leftmost label of the instance's host name, so it has
-- to be a valid DNS label.  The previous check allowed leading and trailing
-- hyphens, which no resolver accepts, and RFC 5891's reserved LDH labels.
-- The `xn--` prefix stays allowed on purpose, so that instances can carry
-- internationalized domain names.
--
-- No rows are rewritten or deleted.  If a database predating this migration
-- holds a slug the new check rejects, ADD CONSTRAINT fails and the offending
-- `local_instances` row has to be corrected by hand before migrating again.
ALTER TABLE "local_instances" DROP CONSTRAINT "instances_slug_check";--> statement-breakpoint
ALTER TABLE "local_instances" ADD CONSTRAINT "local_instances_slug_check" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{2,61}[a-z0-9]$'
        AND ("slug" !~ '^..--' OR "slug" ~ '^xn--'));