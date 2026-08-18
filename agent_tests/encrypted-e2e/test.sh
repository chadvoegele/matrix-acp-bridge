#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
exec "$repo_root/agent_tests/e2e-support/run-with-cleanup.sh" \
  E2E_ENVIRONMENT_FILE \
  agent_tests/encrypted-e2e/environment.json \
  agent_tests/encrypted-e2e/cleanup.mjs \
  agent_tests/encrypted-e2e/setup.sh \
  agent_tests/encrypted-e2e/run.mjs
