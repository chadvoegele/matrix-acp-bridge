#!/bin/sh
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: $0 MODE PROVISION_SCRIPT VERIFY_SCRIPT RUN_SCRIPT" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
mode=$1
provision_script=$2
verify_script=$3
run_script=$4

case $mode in
  encrypted)
    required_names='E2E_HOMESERVER E2E_ROOM_ID E2E_BRIDGE_USER_ID E2E_SENDER_USER_ID E2E_BRIDGE_PASSWORD E2E_SENDER_PASSWORD E2E_ACP_COMMAND'
    ;;
  unencrypted)
    required_names='E2E_HOMESERVER E2E_BRIDGE_USER_ID E2E_SENDER_USER_ID E2E_BRIDGE_PASSWORD E2E_SENDER_PASSWORD E2E_ACP_COMMAND'
    ;;
  *)
    echo "unknown E2E mode: $mode" >&2
    exit 2
    ;;
esac

for name in $required_names; do
  eval "value=\${$name-}"
  if [ -z "$value" ]; then
    echo "$name is required" >&2
    exit 2
  fi
done
if [ "$mode" = unencrypted ] && [ -z "${UNENCRYPTED_E2E_ROOM_ID:-${E2E_ROOM_ID:-}}" ]; then
  echo "UNENCRYPTED_E2E_ROOM_ID or E2E_ROOM_ID is required" >&2
  exit 2
fi

cd "$repo_root"
npm ci
npm run check
node "$repo_root/$provision_script"
if [ -n "$verify_script" ]; then
  node "$repo_root/$verify_script"
fi

if [ "$mode" = encrypted ]; then
  echo "Encrypted E2E devices are ready. Run: node $run_script"
else
  echo "Unencrypted E2E devices are ready. Run: node $run_script"
fi
