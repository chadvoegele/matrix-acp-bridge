#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
exec "$repo_root/agent_tests/e2e-support/setup.sh" encrypted \
  agent_tests/test_encrypted_message/provision.mjs \
  agent_tests/test_encrypted_message/verify-sas.mjs \
  agent_tests/test_encrypted_message/run.mjs
