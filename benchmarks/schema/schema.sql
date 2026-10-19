-- Generated from benchmarks/quickservice/migrations with `quickservice migration script`.
-- Every stack uses exactly these tables. Regenerate with: bun benchmarks/schema/generate.ts
CREATE TABLE "media" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" double precision NOT NULL,
	"storage" text NOT NULL,
	"storage_key" text NOT NULL
);
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL
);
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"age" double precision,
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('member', 'admin'))
);
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" double precision NOT NULL,
	"storage" text NOT NULL,
	"storage_key" text NOT NULL
);
CREATE TABLE "organizations__members" (
	"owner_id" text NOT NULL,
	"target_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "organizations__members_pk" PRIMARY KEY("owner_id","target_id")
);
ALTER TABLE "organizations__members" ADD CONSTRAINT "organizations__members_owner_id_organizations_id_fk" FOREIGN KEY ("owner_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "organizations__members" ADD CONSTRAINT "organizations__members_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "media_created_at_idx" ON "media" USING btree ("created_at");
CREATE INDEX "organizations_created_at_idx" ON "organizations" USING btree ("created_at");
CREATE UNIQUE INDEX "organizations_slug_uq" ON "organizations" USING btree ("slug");
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");
CREATE INDEX "files_created_at_idx" ON "files" USING btree ("created_at");
CREATE INDEX "organizations__members_target_idx" ON "organizations__members" USING btree ("target_id");
