#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
exec "$repo_root/agent_tests/e2e-support/setup.sh" encrypted \
  agent_tests/encrypted-e2e/provision.mjs \
  agent_tests/encrypted-e2e/verify-sas.mjs \
  agent_tests/encrypted-e2e/run.mjs
