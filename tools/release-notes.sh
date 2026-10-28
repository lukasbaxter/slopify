#!/usr/bin/env bash
# Release notes for a tag: one bullet per commit since the previous tag
# (merges and test-only commits left out), then the compare link.
# Usage: tools/release-notes.sh v0.1.112 [owner/repo]
set -euo pipefail
tag="$1"; repo="${2:-lukasbaxter/slopify}"
prev=$(git describe --tags --abbrev=0 --match 'v*' "$tag^" 2>/dev/null || true)
range="${prev:+$prev..}$tag"
git log --no-merges --format='%s' "$range" | grep -v -E '^(e2e|test|tests|ci|lint)[:(]' | sed 's/^/- /' || true
echo
[ -n "$prev" ] && echo "**Full Changelog**: https://github.com/$repo/compare/$prev...$tag"
