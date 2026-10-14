#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
exec "$repo_root/agent_tests/e2e-support/run-with-cleanup.sh" \
  THREAD_ENCRYPTED_ENVIRONMENT_FILE \
  agent_tests/test_thread_sessions/encrypted-environment.json \
  agent_tests/test_thread_sessions/encrypted-cleanup.mjs \
  agent_tests/test_thread_sessions/encrypted-setup.sh \
  agent_tests/test_thread_sessions/encrypted-run.mjs
