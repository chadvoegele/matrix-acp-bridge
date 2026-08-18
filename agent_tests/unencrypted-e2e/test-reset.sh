#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
exec "$repo_root/agent_tests/e2e-support/run-with-cleanup.sh" \
  UNENCRYPTED_E2E_ENVIRONMENT_FILE \
  agent_tests/unencrypted-e2e/environment.json \
  agent_tests/unencrypted-e2e/cleanup.mjs \
  agent_tests/unencrypted-e2e/setup.sh \
  agent_tests/unencrypted-e2e/run-reset.mjs
