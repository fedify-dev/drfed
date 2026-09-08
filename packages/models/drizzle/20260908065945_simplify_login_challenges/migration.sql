-- Existing challenge secrets cannot be recovered from their hashes.
-- Invalidate these short-lived challenges; accounts and sessions are preserved.
DELETE FROM "login_challenges";--> statement-breakpoint
ALTER TABLE "login_challenges" DROP CONSTRAINT "login_tokens_tokenHash_key";--> statement-breakpoint
ALTER TABLE "login_challenges" ADD COLUMN "code" char(6) NOT NULL;--> statement-breakpoint
ALTER TABLE "login_challenges" DROP COLUMN "tokenHash";--> statement-breakpoint
ALTER TABLE "login_challenges" DROP COLUMN "codeHash";