-- 040_ayzen_mailbox_threading.sql
-- Conversation threading for the native ayzen.tech mailbox. Until now every
-- message stood alone — no References header was captured, no outbound
-- message ever got a Message-ID, and the inbox listed one row per email
-- instead of grouping a back-and-forth into a single conversation. This adds:
--   - references_header: the raw RFC "References" header (space-separated
--     Message-IDs, oldest first) so we can find a thread's true root even
--     when the *immediate* parent (In-Reply-To) isn't a message we have.
--   - thread_id: a stable per-conversation key every message in the same
--     thread shares, so the UI can group rows into conversations with one
--     query instead of walking In-Reply-To chains on every page load.

ALTER TABLE ayzen_mailbox_messages
  ADD COLUMN IF NOT EXISTS references_header TEXT,
  ADD COLUMN IF NOT EXISTS thread_id TEXT;

-- Backfill: default every existing row to its own single-message thread
-- (root = its own Message-ID, or a synthetic "row-<id>" for the rare row
-- that has neither a Message-ID nor an In-Reply-To to key off of).
UPDATE ayzen_mailbox_messages
  SET thread_id = COALESCE(message_id, 'row-' || id::text)
  WHERE thread_id IS NULL;

-- Then merge replies into their parent's thread. This is a best-effort,
-- bounded propagation (not a recursive CTE) so it stays simple and
-- terminates: each pass pulls one more "hop" of replies into their parent's
-- thread_id, and 20 passes comfortably covers any real email chain depth
-- while being cheap to run against what's normally a small table.
DO $$
DECLARE
  i INT;
  updated INT;
BEGIN
  FOR i IN 1..20 LOOP
    UPDATE ayzen_mailbox_messages child
      SET thread_id = parent.thread_id
      FROM ayzen_mailbox_messages parent
      WHERE child.in_reply_to IS NOT NULL
        AND parent.message_id = child.in_reply_to
        AND parent.user_id = child.user_id
        AND child.thread_id <> parent.thread_id;
    GET DIAGNOSTICS updated = ROW_COUNT;
    EXIT WHEN updated = 0;
  END LOOP;
END $$;

ALTER TABLE ayzen_mailbox_messages
  ALTER COLUMN thread_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS ayzen_mailbox_messages_thread_idx
  ON ayzen_mailbox_messages (user_id, thread_id, created_at ASC);
