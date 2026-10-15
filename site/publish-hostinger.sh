#!/bin/sh
# Commits the assembled site (_site/) to the `hostinger` branch, which
# Hostinger's Git deployment pulls into admin.quickserve.group. The branch
# holds only the published files and only ever moves forward, so Hostinger's
# `git pull` always fast-forwards.
set -eu
BRANCH=hostinger
PUB=$(mktemp -d)
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git fetch -q origin "$BRANCH"
  git worktree add -q -B "$BRANCH" "$PUB" FETCH_HEAD
else
  git worktree add -q --detach "$PUB"
  git -C "$PUB" checkout -q --orphan "$BRANCH"
  git -C "$PUB" rm -rqf .
fi
find "$PUB" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a _site/. "$PUB"/
git -C "$PUB" add -A
if git -C "$PUB" diff --cached --quiet; then
  echo "hostinger branch already up to date"
else
  git -C "$PUB" commit -qm "Publish console from ${GITHUB_SHA:-$(git rev-parse HEAD)}"
  git -C "$PUB" push -q origin "$BRANCH"
  echo "published to $BRANCH"
fi
git worktree remove --force "$PUB"
