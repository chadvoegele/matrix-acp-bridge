# Matrix outage recovery

Encrypted output resumes after a roughly one-minute Matrix outage, without
restarting the bridge. Retried sends keep their transaction identity, and a
subsequent message in the same room receives an encrypted response.
