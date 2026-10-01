#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
exec "$repo_root/agent_tests/e2e-support/run-with-cleanup.sh" \
  THREAD_ENCRYPTED_ENVIRONMENT_FILE \
  agent_tests/thread-sessions/encrypted-environment.json \
  agent_tests/thread-sessions/encrypted-cleanup.mjs \
  agent_tests/thread-sessions/encrypted-setup.sh \
  agent_tests/thread-sessions/encrypted-run.mjs
