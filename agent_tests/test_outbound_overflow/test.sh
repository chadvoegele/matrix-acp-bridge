#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
case ${1:-plaintext} in
  plaintext|encrypted) transport=${1:-plaintext} ;;
  *) echo "usage: $0 [plaintext|encrypted]" >&2; exit 2 ;;
esac
exec node "$repo_root/agent_tests/e2e-support/live-all.mjs" "$transport-thread-overflow"
