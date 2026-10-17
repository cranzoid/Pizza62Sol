-- AI phone receptionist, website parity: the caller's checkout choices.
--
-- Additive only. One column on voice_calls holding the schedule, promo code
-- and tip the caller asked for — choices, never amounts; quoteOrder prices
-- them. Existing rows get '{}', which means ASAP, no code and no tip: exactly
-- what every voice order was before. No ordering table is touched.
ALTER TABLE "voice_calls" ADD COLUMN "order_options_json" text DEFAULT '{}' NOT NULL;
