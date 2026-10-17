ALTER TABLE "voice_calls" ADD COLUMN "called_number" text;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "forwarded_from" text;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "registration_state" text;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "twilio_status" text;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "twilio_status_sequence" integer;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "call_duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD COLUMN "post_call_received_at" bigint;