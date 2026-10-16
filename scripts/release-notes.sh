#!/usr/bin/env bash
# Release notes for a version: the commits since the previous v* tag,
# grouped by their conventional-commit type, merges left out.
#
# usage: scripts/release-notes.sh <version> [<commit>]
set -euo pipefail

version="$1"
head="${2:-HEAD}"
repo="Spantree/backlog-ranker"
prev="$(git describe --tags --abbrev=0 --match 'v*' "$head^" 2>/dev/null || true)"
range="${prev:+$prev..}$head"

# section <title> <grep flags> <types>
section() {
  local title="$1" flags="$2" types="$3" lines
  lines="$(git log --no-merges --format='- %s (%h)' "$range" | grep $flags "^- ($types)(\(|:|!)" || true)"
  if [ -n "$lines" ]; then printf '## %s\n\n%s\n\n' "$title" "$lines"; fi
}

echo "npm: https://www.npmjs.com/package/@feniix/backlog-ranker/v/$version"
echo
section "Features" -E "feat"
section "Fixes" -E "fix"
section "Docs" -E "docs"
section "Other" -vE "feat|fix|docs"
if [ -n "$prev" ]; then
  echo "**Full changelog**: https://github.com/$repo/compare/$prev...v$version"
fi
