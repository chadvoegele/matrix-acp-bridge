#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
E2E_ACP_COMMAND=$(node -p 'JSON.stringify([process.execPath, process.argv[1]])' \
  "$repo_root/agent_tests/e2e-support/scripted-unified-acp.mjs")
E2E_UNIFIED_TRANSPORT=${1:-plaintext}
E2E_UNIFIED_RESPONSE_MODE=${2:-room}
export E2E_ACP_COMMAND E2E_UNIFIED_TRANSPORT E2E_UNIFIED_RESPONSE_MODE
case "$E2E_UNIFIED_TRANSPORT/$E2E_UNIFIED_RESPONSE_MODE" in
  plaintext/room)
    set -- UNENCRYPTED_E2E_ENVIRONMENT_FILE agent_tests/test_unencrypted_message/environment.json \
      agent_tests/test_unencrypted_message/cleanup.mjs agent_tests/test_unencrypted_message/setup.sh ;;
  encrypted/room)
    set -- E2E_ENVIRONMENT_FILE agent_tests/test_encrypted_message/environment.json \
      agent_tests/test_encrypted_message/cleanup.mjs agent_tests/test_encrypted_message/setup.sh ;;
  plaintext/thread)
    set -- THREAD_PLAINTEXT_ENVIRONMENT_FILE agent_tests/test_thread_sessions/plaintext-environment.json \
      agent_tests/test_thread_sessions/plaintext-cleanup.mjs agent_tests/test_thread_sessions/plaintext-setup.sh ;;
  encrypted/thread)
    set -- THREAD_ENCRYPTED_ENVIRONMENT_FILE agent_tests/test_thread_sessions/encrypted-environment.json \
      agent_tests/test_thread_sessions/encrypted-cleanup.mjs agent_tests/test_thread_sessions/encrypted-setup.sh ;;
  *) echo "usage: $0 [plaintext|encrypted] [room|thread]" >&2; exit 2 ;;
esac
exec "$repo_root/agent_tests/e2e-support/run-with-cleanup.sh" "$@" agent_tests/e2e-support/unified-wire.mjs
