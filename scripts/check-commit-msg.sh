#!/bin/sh
# Rejects a commit message that carries a trailer line (Co-authored-by, Signed-off-by and the like) or says it was generated.
# Used as the commit-msg hook (lefthook passes the path of the message file) and callable on any text: check-commit-msg.sh FILE.
set -eu
file=${1:?usage: check-commit-msg.sh MESSAGE_FILE}
bad=$(grep -v '^#' "$file" | grep -inE "^(co-authored-by|signed-off-by|reviewed-by|assisted-by|generated-by)[[:space:]]*:|generated (by|with)" || true)
if [ -n "$bad" ]; then
  echo "commit message refused: trailers and generation notes do not belong in a commit message:" >&2
  echo "$bad" >&2
  exit 1
fi
