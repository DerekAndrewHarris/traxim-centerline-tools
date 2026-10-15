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

set -euo pipefail

APP=/var/www/TraximCenterlineTools
SERVICE=traxim-file-generator

fail() { echo "DEPLOY ABORTED: $1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must run as root (via sudo)"
[ -d "$APP/.git" ]   || fail "$APP is not a git copy - refusing to guess"

cd "$APP"
git config --global --add safe.directory "$APP" 2>/dev/null || true

echo "Was at: $(git log -1 --oneline)"
git fetch origin main
git reset --hard origin/main
echo "Now at: $(git log -1 --oneline)"

# Cache-busting build id in index.html (used as ?v= on the front-end files).
BUILD_ID=$(git rev-parse --short HEAD)
sed -i "s/__BUILD_ID__/$BUILD_ID/g" index.html
echo "Stamped build ID: $BUILD_ID"

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
