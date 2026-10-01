#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
exec "$repo_root/agent_tests/e2e-support/setup.sh" encrypted \
  agent_tests/thread-sessions/encrypted-provision.mjs \
  agent_tests/thread-sessions/encrypted-verify-sas.mjs \
  agent_tests/thread-sessions/encrypted-run.mjs
