#!/usr/bin/env bash
# Attach the built files in DIR to the GitHub release for TAG (making the
# release if there is none yet), then write its notes from the files the
# release really has. Run by .github/workflows/release.yml on every publish,
# including a re-run after a failed job: the notes then pick up the file that
# run added instead of keeping the first run's "not in this release".
# Usage: tools/publish-release.sh v0.1.162 owner/repo out
set -euo pipefail
tag="$1"; repo="$2"; dir="$3"
here="$(cd "$(dirname "$0")" && pwd)"
gh release view "$tag" -R "$repo" >/dev/null 2>&1 || gh release create "$tag" -R "$repo" --notes "$(ASSETS="$(ls "$dir")" bash "$here/release-notes.sh" "$tag" "$repo")"
# One file at a time with retries: GitHub's asset upload API dropped parallel
# uploads of these ~100 MB files ("other side closed", "Error creating asset
# temp dir") on the first two releases.
for f in "$dir"/*; do
  for i in 1 2 3 4 5; do gh release upload "$tag" "$f" -R "$repo" --clobber && break || sleep "${UPLOAD_RETRY_SLEEP:-15}"; done
done
assets=$(gh release view "$tag" -R "$repo" --json assets -q '.assets[].name')
echo "$assets"
notes=$(mktemp); trap 'rm -f "$notes"' EXIT
ASSETS="$assets" bash "$here/release-notes.sh" "$tag" "$repo" >"$notes"
gh release edit "$tag" -R "$repo" --notes-file "$notes"
