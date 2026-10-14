#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
exec "$repo_root/agent_tests/e2e-support/run-with-cleanup.sh" \
  E2E_ENVIRONMENT_FILE \
  agent_tests/test_encrypted_message/environment.json \
  agent_tests/test_encrypted_message/cleanup.mjs \
  agent_tests/test_encrypted_message/setup.sh \
  agent_tests/test_encrypted_message/run.mjs
