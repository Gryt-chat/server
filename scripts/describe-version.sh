#!/usr/bin/env bash
# Prints the version a checkout is, without a leading v: the highest tag on HEAD, else
# `git describe`. "unknown" when the directory isn't the top of its own git checkout.
set -euo pipefail

dir="${1:?usage: describe-version.sh <dir>}"

top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$top" || "$(cd "$top" && pwd -P)" != "$(cd "$dir" && pwd -P)" ]]; then
  echo "unknown"
  exit 0
fi

# versionsort.suffix puts v1.6.15 above v1.6.15-beta.1 when both sit on one commit.
version=$(git -C "$dir" \
    -c versionsort.suffix=-alpha \
    -c versionsort.suffix=-beta \
    -c versionsort.suffix=-rc \
    tag --points-at HEAD --sort=-v:refname | head -n 1 || true)

if [[ -z "$version" ]]; then
  version=$(git -C "$dir" describe --tags --always 2>/dev/null || true)
fi

version="${version#v}"
echo "${version:-unknown}"
