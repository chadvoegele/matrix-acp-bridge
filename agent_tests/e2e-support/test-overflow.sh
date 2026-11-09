#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
E2E_ACP_COMMAND=$(node -p 'JSON.stringify([process.execPath, process.argv[1]])' \
  "$repo_root/agent_tests/e2e-support/scripted-overflow-acp.mjs")
export E2E_ACP_COMMAND
: "${E2E_OVERFLOW_REPORT:?Set a private absolute report path outside the worktree}"
case ${1:-plaintext} in
  plaintext)
    set -- THREAD_PLAINTEXT_ENVIRONMENT_FILE agent_tests/test_thread_sessions/plaintext-environment.json \
      agent_tests/test_thread_sessions/plaintext-cleanup.mjs agent_tests/test_thread_sessions/plaintext-setup.sh ;;
  encrypted)
    set -- THREAD_ENCRYPTED_ENVIRONMENT_FILE agent_tests/test_thread_sessions/encrypted-environment.json \
      agent_tests/test_thread_sessions/encrypted-cleanup.mjs agent_tests/test_thread_sessions/encrypted-setup.sh ;;
  *) echo "usage: $0 [plaintext|encrypted]" >&2; exit 2 ;;
esac
exec "$repo_root/agent_tests/e2e-support/run-with-cleanup.sh" "$@" agent_tests/e2e-support/overflow-wire.mjs
