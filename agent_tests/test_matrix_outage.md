# Matrix outage recovery

Output resumes after a roughly one-minute Matrix outage, without restarting the
bridge, in both encrypted and unencrypted rooms. Retried sends keep their
transaction identity, and a subsequent message in the same room receives a
response. Encrypted rooms retain encrypted delivery without plaintext fallback.
