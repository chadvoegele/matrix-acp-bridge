#!/bin/sh
set -eu

if [ "$#" -ne 5 ]; then
  echo "usage: $0 ENVIRONMENT_VARIABLE DEFAULT_ENVIRONMENT CLEANUP_SCRIPT SETUP_SCRIPT RUNNER_SCRIPT" >&2
  exit 2
fi

# Hold the shared lock across checks, provisioning, verification, tests and cleanup.
if [ "${E2E_LIVE_LOCK_HELD:-}" != 1 ]; then
  exec flock -n /tmp/matrix-acp-bridge-steering-live.lock env E2E_LIVE_LOCK_HELD=1 "$0" "$@"
fi

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
environment_variable=$1
default_environment=$2
cleanup_script=$3
setup_script=$4
runner_script=$5
eval "environment_file=\${$environment_variable-}"
if [ -z "$environment_file" ]; then
  environment_file="$repo_root/$default_environment"
fi
case $environment_file in
  /*) ;;
  *) environment_file=$(pwd)/$environment_file ;;
esac

if [ -e "$environment_file" ]; then
  echo "Existing E2E environment requires explicit recovery/cleanup before another test invocation" >&2
  exit 2
fi

# Setup runs from the repository root; keep its path identical to cleanup's.
export "$environment_variable=$environment_file"

cleanup_on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -f "$environment_file" ]; then
    if ! node "$repo_root/$cleanup_script" "$environment_file"; then
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

"$repo_root/$setup_script"
node "$repo_root/$runner_script" "$environment_file"
