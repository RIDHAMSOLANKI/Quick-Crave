-- Quick-Crave: per-dish stock (inventory). Safe to run more than once.
--
-- stock = NULL  -> unlimited (tea, coffee: things the canteen never runs out of)
-- stock = N     -> N portions left
--
-- Stock is taken at PAYMENT, inside the same transaction as the wallet debit:
--   UPDATE dishes SET stock = stock - qty WHERE dish_id = ? AND stock >= qty
-- If any dish is short, the whole payment rolls back (no money, no stock taken).
-- The CHECK below is the last line of defence: stock can never go negative.

ALTER TABLE dishes ADD COLUMN IF NOT EXISTS stock INTEGER;

DO $$ BEGIN
  ALTER TABLE dishes ADD CONSTRAINT stock_non_negative CHECK (stock IS NULL OR stock >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
