#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
exec "$repo_root/agent_tests/e2e-support/setup.sh" unencrypted \
  agent_tests/test_unencrypted_message/provision.mjs \
  "" \
  agent_tests/test_unencrypted_message/run.mjs
