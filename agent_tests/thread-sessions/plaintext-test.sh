#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
exec "$repo_root/agent_tests/e2e-support/run-with-cleanup.sh" \
  THREAD_PLAINTEXT_ENVIRONMENT_FILE \
  agent_tests/thread-sessions/plaintext-environment.json \
  agent_tests/thread-sessions/plaintext-cleanup.mjs \
  agent_tests/thread-sessions/plaintext-setup.sh \
  agent_tests/thread-sessions/plaintext-run.mjs
