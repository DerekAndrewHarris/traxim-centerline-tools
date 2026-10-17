#!/bin/bash
#
# PROPOSED (not yet in use). Installs the latest main branch of the File Generator on the server.
#
# Intended to live on the server at /usr/local/bin/deploy-file-generator, owned by root, and to be the
# ONLY thing the 'deploy-fg' user may run with sudo (see /etc/sudoers.d/deploy-file-generator). The
# GitHub workflow would then log in as deploy-fg with its own key and run:
#   sudo /usr/local/bin/deploy-file-generator
# instead of logging in as root. It does the same steps the current workflow does as root.
#
# It takes no arguments on purpose, so whoever holds the deploy key can install what is on GitHub's
# main branch and nothing else. If this script changes, re-install it on the server by hand; the
# workflow must never update it (so a stolen deploy key cannot rewrite it).
#
# Rollback (by hand, as root):
#   cd /var/www/TraximCenterlineTools && git reset --hard <previous commit> && systemctl restart traxim-file-generator
#   (the previous commit is printed below as "Was at:")
#   If that deploy changed the libraries ("package files changed" in its log), also put the previous
#   ones back first:  rm -rf node_modules && mv node_modules.old node_modules

set -euo pipefail

APP=/var/www/TraximCenterlineTools
SERVICE=traxim-file-generator

fail() { echo "DEPLOY ABORTED: $1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must run as root (via sudo)"
[ -d "$APP/.git" ]   || fail "$APP is not a git copy - refusing to guess"

cd "$APP"
git config --global --add safe.directory "$APP" 2>/dev/null || true

WAS=$(git rev-parse HEAD)
echo "Was at: $(git log -1 --oneline)"
git fetch origin main
git reset --hard origin/main
NOW=$(git rev-parse HEAD)
echo "Now at: $(git log -1 --oneline)"

# Cache-busting build id in index.html (used as ?v= on the front-end files).
stamp_build_id() {
  BUILD_ID=$(git rev-parse --short HEAD)
  sed -i "s/__BUILD_ID__/$BUILD_ID/g" index.html
  echo "Stamped build ID: $BUILD_ID"
}

# Libraries: only when package.json / package-lock.json changed (added 17 Oct 2026; before, this was a
# manual "npm ci --omit=dev" on the server that was easy to forget). The new node_modules is built in
# a temporary folder as www-data (not root), and only swapped in if npm ci succeeds; the previous one
# is kept as node_modules.old. If npm ci fails, the code goes back to the previous commit and the
# service is not restarted, so the running version is untouched.
if [ "$WAS" != "$NOW" ] && ! git diff --quiet "$WAS" "$NOW" -- package.json package-lock.json; then
  echo "package files changed: npm ci --omit=dev (as www-data, in a temporary folder)"
  NPMDIR=$(mktemp -d /var/tmp/file-generator-npm.XXXXXX)
  cp package.json package-lock.json "$NPMDIR/"
  chown -R www-data:www-data "$NPMDIR"
  if runuser -u www-data -- env HOME="$NPMDIR" npm_config_cache="$NPMDIR/.npm" npm_config_update_notifier=false \
       bash -c "cd '$NPMDIR' && npm ci --omit=dev --no-audit --no-fund"; then
    rm -rf "$APP/node_modules.old"
    [ -d "$APP/node_modules" ] && mv "$APP/node_modules" "$APP/node_modules.old"
    mv "$NPMDIR/node_modules" "$APP/node_modules"
    rm -rf "$NPMDIR"
  else
    rm -rf "$NPMDIR"
    git reset --hard "$WAS"
    stamp_build_id
    chown -R www-data:www-data "$APP"
    fail "npm ci failed - files put back to $(git log -1 --oneline); service not restarted"
  fi
fi

stamp_build_id

# Same ownership as before. Files readable, not executable, by others (the old chmod -R 755 made every
# file executable). .env stays readable only by the service user.
chown -R www-data:www-data "$APP"
chmod -R u=rwX,go=rX "$APP"
[ -f "$APP/.env" ] && chmod 600 "$APP/.env"

systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  echo "=== Deployed: $SERVICE is active ==="
else
  echo "Service failed to start!" >&2
  journalctl -u "$SERVICE" -n 30 --no-pager >&2
  exit 1
fi
