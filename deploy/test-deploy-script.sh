#!/bin/bash
#
# Local test of deploy/deploy-file-generator.sh on a SIMULATED server (never the real one).
#
# Run as root on Linux or WSL:
#   sudo NODE_DIR=/path/to/node-v22-linux-x64 bash deploy/test-deploy-script.sh
# Needs network access (npm ci). Runs in a private mount namespace with an empty temporary /var/www,
# a local bare repository standing in for GitHub, the real backend/server.js run by a fake systemctl
# as www-data, and HOME pointed at a temporary folder (the script writes git's safe.directory into
# root's git config). Nothing outside the temporary folders is changed.
#
# Scenarios: a deploy that changes the package files (npm ci runs, previous libraries kept as
# node_modules.old), a deploy with no package change (no npm ci), and a deploy whose npm ci fails
# (code put back, service not restarted, libraries untouched). .env must survive every time.

set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
if [ -z "${TRAXIM_SIM_NS:-}" ]; then
  exec unshare --mount --propagation private env TRAXIM_SIM_NS=1 bash "$0" "$@"
fi
# (If this machine has no /var/www, an empty one is made for the mount and removed at the end.)
MADE_MOUNTPOINT=0
[ -d /var/www ] || { mkdir /var/www && MADE_MOUNTPOINT=1; }
mount -t tmpfs -o mode=755 traxim-sim-www /var/www || { echo "could not mount a temporary /var/www - stopping" >&2; exit 1; }

HERE=$(cd "$(dirname "$0")" && pwd)
SRC_REPO=$(cd "$HERE/.." && pwd)
NODE_DIR=${NODE_DIR:-$(dirname "$(dirname "$(command -v node)")")}
[ -x "$NODE_DIR/bin/node" ] || { echo "Set NODE_DIR to a Node 22 folder (with bin/node)." >&2; exit 1; }
PORT=${PORT:-39124}
ROOT=$(mktemp -d /tmp/fg-deploy-sim-XXXXXX); chmod 755 "$ROOT"
APP=/var/www/TraximCenterlineTools
mkdir -p "$ROOT/bin" "$ROOT/run" "$ROOT/home" "$ROOT/node"; chmod 777 "$ROOT/run"
cp -a "$NODE_DIR/." "$ROOT/node/"; chmod -R a+rX "$ROOT/node"
export PATH="$ROOT/bin:$ROOT/node/bin:$PATH" HOME="$ROOT/home"
cleanup() {
  systemctl stop x >/dev/null 2>&1
  [ "${KEEP:-0}" = 1 ] || rm -rf "$ROOT"
  umount /var/www 2>/dev/null && [ "$MADE_MOUNTPOINT" = 1 ] && rmdir /var/www
}
trap cleanup EXIT

PASS=0; FAIL=0
check() { local d=$1; shift; if "$@"; then PASS=$((PASS+1)); echo "  ok    $d"; else FAIL=$((FAIL+1)); echo "  FAIL  $d"; fi; }

cat > "$ROOT/bin/systemctl" <<EOF
#!/bin/bash
PIDF=$ROOT/run/server.pid
stop() { [ -f \$PIDF ] && { kill \$(cat \$PIDF) 2>/dev/null; sleep 0.5; rm -f \$PIDF; }; }
case "\$1" in
  restart) stop; : > $ROOT/run/journal.log; chmod 666 $ROOT/run/journal.log
    ( cd $APP && setsid runuser -u www-data -- env PATH="$ROOT/node/bin:/usr/bin:/bin" PORT=$PORT NODE_ENV=production \\
        bash -c 'echo \$\$ > $ROOT/run/server.pid; exec node backend/server.js' >> $ROOT/run/journal.log 2>&1 < /dev/null & )
    for i in \$(seq 50); do [ -f \$PIDF ] && break; sleep 0.1; done
    echo restart >> $ROOT/run/restarts.log ;;
  stop) stop ;;
  is-active) [ -f \$PIDF ] && kill -0 \$(cat \$PIDF) 2>/dev/null ;;
esac
EOF
printf '#!/bin/bash\ncat %s/run/journal.log\n' "$ROOT" > "$ROOT/bin/journalctl"
chmod 755 "$ROOT/bin/systemctl" "$ROOT/bin/journalctl"

# "GitHub": a bare repository. The server copy starts at the commit before the last package change.
OWNER=$(stat -c %U "$SRC_REPO"); mkdir "$ROOT/src"; chown "$OWNER" "$ROOT/src"
runuser -u "$OWNER" -- git clone -q "$SRC_REPO" "$ROOT/src" || { echo "clone failed"; exit 1; }
chown -R root:root "$ROOT/src"
git -C "$ROOT/src" config user.email test@example.com; git -C "$ROOT/src" config user.name test
git clone -q --bare "$ROOT/src" "$ROOT/origin.git"
LOCK_COMMIT=$(git -C "$ROOT/src" log -1 --format=%H -- package-lock.json)
OLD=$(git -C "$ROOT/src" rev-parse "$LOCK_COMMIT~1"); NEW=$(git -C "$ROOT/src" rev-parse HEAD)
git -C "$ROOT/origin.git" update-ref refs/heads/main "$NEW"
git clone -q "$ROOT/origin.git" "$APP"; git -C "$APP" reset -q --hard "$OLD"
( cd "$APP" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) || { echo "npm ci (old) failed"; exit 1; }
printf 'OVERPASS_API_URL=http://127.0.0.1:12345/api/interpreter\nALLOWED_ORIGINS=https://example.test\n' > "$APP/.env"
chown -R www-data:www-data "$APP"
ENV_SUM=$(sha256sum < "$APP/.env")
systemctl restart traxim-file-generator
echo "Simulated server: was ${OLD:0:7}, GitHub main ${NEW:0:7}"

run() { bash "$SRC_REPO/deploy/deploy-file-generator.sh" > "$ROOT/last.txt" 2>&1; }
health() { for i in $(seq 30); do curl -fsS "http://127.0.0.1:$PORT/api/file-generator/health" 2>/dev/null | grep -q operational && return 0; sleep 0.5; done; return 1; }
env_ok() { [ "$(sha256sum < "$APP/.env")" = "$ENV_SUM" ] && [ "$(stat -c %a "$APP/.env")" = 600 ]; }

echo "1. Deploy that changes package-lock.json"
run; rc=$?
check "succeeded (exit $rc)" [ $rc -eq 0 ]
check "now at the new commit" [ "$(git -C "$APP" rev-parse HEAD)" = "$NEW" ]
check "npm ci ran" grep -q "package files changed" "$ROOT/last.txt"
check "libraries match the new lock (no multer any more)" [ ! -d "$APP/node_modules/multer" ]
check "previous libraries kept as node_modules.old" [ -d "$APP/node_modules.old/multer" ]
check "build id stamped" grep -q "?v=${NEW:0:7}" "$APP/index.html"
check ".env unchanged (and readable only by its owner)" env_ok
check "service healthy" health

echo "2. Deploy with no package change"
git -C "$ROOT/src" commit -q --allow-empty -m "empty change"; git -C "$ROOT/src" push -q "$ROOT/origin.git" HEAD:main
INODE=$(stat -c %i "$APP/node_modules")
run; rc=$?
check "succeeded (exit $rc)" [ $rc -eq 0 ]
check "no npm ci" bash -c "! grep -q 'package files changed' '$ROOT/last.txt'"
check "node_modules untouched" [ "$(stat -c %i "$APP/node_modules")" = "$INODE" ]
check "service healthy" health

echo "3. Deploy whose npm ci fails"
GOOD=$(git -C "$APP" rev-parse HEAD)
( cd "$ROOT/src" && node -e "const f='package-lock.json',j=JSON.parse(require('fs').readFileSync(f));
  j.packages['node_modules/cors'].integrity='sha512-'+Buffer.alloc(64).toString('base64');
  require('fs').writeFileSync(f, JSON.stringify(j,null,2)+'\n')" && git commit -qam "broken lock" && git push -q "$ROOT/origin.git" HEAD:main )
RESTARTS=$(wc -l < "$ROOT/run/restarts.log")
run; rc=$?
check "reported failure (exit $rc)" [ $rc -ne 0 ]
check "says npm ci failed" grep -q "npm ci failed" "$ROOT/last.txt"
check "files back at the previous commit" [ "$(git -C "$APP" rev-parse HEAD)" = "$GOOD" ]
check "build id stamped again" grep -q "?v=${GOOD:0:7}" "$APP/index.html"
check "service NOT restarted" [ "$(wc -l < "$ROOT/run/restarts.log")" = "$RESTARTS" ]
check "node_modules untouched" [ "$(stat -c %i "$APP/node_modules")" = "$INODE" ]
check ".env unchanged" env_ok
check "service healthy" health

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || cat "$ROOT/last.txt"
[ "$FAIL" -eq 0 ]
