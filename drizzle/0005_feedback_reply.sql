-- Replying to feedback.
--
-- Generated from db/schema.ts. Until now the only thing that could be done with
-- a piece of feedback was to mark it handled and write a note nobody outside
-- the office would ever read: the customer who took the trouble to answer heard
-- nothing back. These columns are the record of the reply that now goes out.
--
-- All three are nullable and additive. Every response already in the table is
-- one nobody has replied to, which is the truth rather than a gap to backfill.

ALTER TABLE "feedback_responses" ADD COLUMN "reply_message" text;--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD COLUMN "replied_at" bigint;--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD COLUMN "replied_by" text;
