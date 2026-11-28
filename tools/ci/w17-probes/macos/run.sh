#!/bin/bash
set -euo pipefail
umask 077

case "${1:-}" in
  primitives|package|cleanup) phase=$1 ;;
  *) exit 64 ;;
esac
: "${W17_OUT:?export a fresh controller-owned 0700 directory}"
cd "$(dirname "$0")/../../../.."
driver=tools/ci/w17-probes/macos/probe.mjs
if [[ $phase == cleanup ]]; then
  recovery=0
  node tools/ci/w17-probes/evidence.mjs recover || recovery=$?
  node "$driver" cleanup
  exit "$recovery"
fi

interrupt() {
  trap - TERM INT
  kill -TERM "$worker" 2>/dev/null || true
  wait "$worker" || true
  node "$driver" cleanup
  exit 130
}
node "$driver" "$phase" &
worker=$!
trap interrupt TERM INT
wait "$worker"
