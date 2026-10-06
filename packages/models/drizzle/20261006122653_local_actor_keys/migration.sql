CREATE TYPE "local_actor_key_type" AS ENUM('RSASSA-PKCS1-v1_5', 'Ed25519');--> statement-breakpoint
CREATE TABLE "local_actor_keys" (
	"local_actor_id" uuid,
	"type" "local_actor_key_type",
	"public_key" jsonb NOT NULL,
	"private_key" jsonb NOT NULL,
	CONSTRAINT "local_actor_keys_pkey" PRIMARY KEY("local_actor_id","type"),
	CONSTRAINT "local_actor_keys_public_key_check" CHECK (jsonb_typeof("public_key") = 'object' AND NOT ("public_key" ?| array['d','p','q','dp','dq','qi','oth','k']))
);
--> statement-breakpoint
ALTER TABLE "local_actor_keys" ADD CONSTRAINT "local_actor_keys_local_actor_id_local_actors_id_fkey" FOREIGN KEY ("local_actor_id") REFERENCES "local_actors"("id") ON DELETE CASCADE;