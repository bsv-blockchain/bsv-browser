#!/bin/bash
# Stands in for `node` on CI. Gradle reports "node exited 1" and throws away
# the script output; this writes the failing invocation to e2e/output.
set -u
real="${NODE_REAL:?NODE_REAL is not set}"
log="${GITHUB_WORKSPACE:-.}/e2e/output/node-calls.log"
out="$(mktemp)"
"$real" "$@" >"$out" 2>&1
code=$?
if [[ $code -ne 0 ]]; then
  mkdir -p "$(dirname "$log")"
  {
    echo "FAIL $code: $*"
    cat "$out"
  } >>"$log"
fi
cat "$out"
rm -f "$out"
exit $code
