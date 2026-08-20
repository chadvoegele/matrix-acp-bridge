# Completed-ID recovery Matrix E2E test

Prove that normal initial-sync recovery suppresses a prompt whose ACP turn was
completed before restart, retries an event whose turn was interrupted, restores
the ACP session when supported, and leaves bounded schema-v12 state without
legacy cursor or pending-batch fields.
