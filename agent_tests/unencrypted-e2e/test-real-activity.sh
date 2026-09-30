#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
if [ -z "${E2E_REAL_SCRATCH_DIR:-}" ] || [ -z "${E2E_REAL_SCRATCH_CLEANUP_COMMAND:-}" ]; then
  echo 'E2E_REAL_SCRATCH_DIR and E2E_REAL_SCRATCH_CLEANUP_COMMAND are required' >&2
  exit 2
fi
exec "$repo_root/agent_tests/e2e-support/run-with-cleanup.sh" \
  UNENCRYPTED_E2E_ENVIRONMENT_FILE \
  agent_tests/unencrypted-e2e/environment.json \
  agent_tests/unencrypted-e2e/cleanup.mjs \
  agent_tests/unencrypted-e2e/setup.sh \
  agent_tests/unencrypted-e2e/real-activity.mjs
