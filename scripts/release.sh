#!/usr/bin/env bash
# scripts/release.sh — cut a tagged Pi Codemode release.
#
# Usage:
#   ./scripts/release.sh [--version 0.1.3]
#
# With --version, updates package.json/package-lock.json, runs checks, and commits
# the version bump. Then it dry-runs npm pack, creates v<version>, and pushes the
# tag via npm run publish:tag.

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="${2:-}"
      shift 2 || { echo "error: --version needs an argument" >&2; exit 2; }
      ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

log() { printf '[release] %s\n' "$*"; }

if [ -n "$VERSION" ] && ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)?$ ]]; then
  echo "error: version must look like 0.1.3, got '$VERSION'" >&2
  exit 2
fi

log "checking clean working tree"
npm run check:clean-tree

if [ -n "$VERSION" ]; then
  log "setting npm package version to $VERSION"
  npm version "$VERSION" --no-git-tag-version

  log "running full checks"
  npm run check

  log "committing version bump"
  git add package.json package-lock.json
  git commit -m "chore: bump version to $VERSION"
else
  log "using current package version"
fi

log "packing, tagging, and pushing release tag"
npm run publish:tag

TAG="v$(node -p "require('./package.json').version")"
printf '\n✅ Release tag pushed: %s\n' "$TAG"
