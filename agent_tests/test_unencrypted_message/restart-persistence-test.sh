#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
exec "$repo_root/agent_tests/e2e-support/run-with-cleanup.sh" \
  UNENCRYPTED_E2E_ENVIRONMENT_FILE \
  agent_tests/test_unencrypted_message/environment.json \
  agent_tests/test_unencrypted_message/cleanup.mjs \
  agent_tests/test_unencrypted_message/setup.sh \
  agent_tests/test_unencrypted_message/restart-persistence-run.mjs
