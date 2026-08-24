CREATE UNIQUE INDEX "clock_event_exact_uq" ON "time_clock_events" USING btree ("staff_user_id","action","occurred_at");--> statement-breakpoint
ALTER TABLE "time_clock_events" ADD CONSTRAINT "clock_events_source" CHECK (source IN ('self_service', 'kiosk', 'manager'));--> statement-breakpoint
ALTER TABLE "time_clock_state" ADD CONSTRAINT "clock_state_value" CHECK (state IN ('clocked_out', 'working', 'on_break'));--> statement-breakpoint
ALTER TABLE "time_clock_state" ADD CONSTRAINT "clock_state_session" CHECK (state = 'clocked_out' OR session_id IS NOT NULL);