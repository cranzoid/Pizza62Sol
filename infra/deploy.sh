#!/usr/bin/env bash
#
# Manual deploy. The GitHub Actions workflow is the normal path — this is what
# you run when the pipeline is unavailable, or the first time, before the
# repository has been wired up.
#
# It does the same thing in the same order, and the order is the point: build,
# test, publish to the *staging slot*, wait for it to answer correctly, and only
# then swap. Production never serves a starting instance, and a build whose
# migrations fail never becomes production at all.
#
set -euo pipefail

cd "$(dirname "$0")/.."

APP_ROOT="$PWD"
RESOURCE_GROUP="${RESOURCE_GROUP:-$(terraform -chdir=infra output -raw resource_group)}"
APP_NAME="${APP_NAME:-$(terraform -chdir=infra output -raw app_name)}"

echo "==> Verifying"
# A deploy that skipped the tests is a deploy that might break checkout, and
# this script exists precisely for the moments when someone is in a hurry.
npx tsc --noEmit
npm run lint
npm test
npm run build

echo "==> Packaging"
rm -f build.zip
# `output: "standalone"` makes Vinext trace only the dependencies the server
# imports at runtime. That removes the build toolchain and the platform-specific
# Rolldown binary from the release, so a deploy no longer needs a second Linux
# npm install or a 100+ MB node_modules archive.
RELEASE_DIR="$(mktemp -d /tmp/pizza62-release.XXXXXX)"
trap 'rm -f "$APP_ROOT/build.zip"; rm -rf "$RELEASE_DIR"' EXIT
cp -R dist/standalone/. "$RELEASE_DIR/"
cp -R drizzle scripts db lib "$RELEASE_DIR/"
cp startup.sh alias-hooks.mjs register-alias.mjs "$RELEASE_DIR/"
test -f "$RELEASE_DIR/server.js"
test -f "$RELEASE_DIR/node_modules/vinext/dist/server/prod-server.js"

# A future runtime dependency might contain a native binary. A standalone build
# made on macOS would then contain the Darwin binary, not the Linux one Azure
# needs; fail clearly and use the Linux GitHub workflow in that case.
if [ "$(uname -s)" != "Linux" ] && find "$RELEASE_DIR" -type f -name '*.node' -print -quit | grep -q .; then
  echo "!!! The standalone release contains a native Node binary. Build it with the Linux GitHub workflow." >&2
  exit 1
fi

(cd "$RELEASE_DIR" && zip -qr "$APP_ROOT/build.zip" .)
ls -lh build.zip

echo "==> Publishing to the staging slot"
az webapp deploy \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --slot staging \
  --type zip \
  --src-path build.zip

echo "==> Waiting for staging to be healthy"
# /api/health touches the database, so this catches a failed migration on the
# slot rather than after it is already serving customers.
for attempt in $(seq 1 40); do
  if curl -fsS --max-time 10 "https://${APP_NAME}-staging.azurewebsites.net/api/health" | grep -q '"status":"ok"'; then
    echo "    healthy after ${attempt} attempts"
    break
  fi
  if [ "$attempt" -eq 40 ]; then
    echo "!!! Staging never became healthy. Production is untouched." >&2
    echo "    Logs: az webapp log tail -g $RESOURCE_GROUP -n $APP_NAME --slot staging" >&2
    exit 1
  fi
  sleep 15
done

echo "==> Swapping into production"
az webapp deployment slot swap \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --slot staging \
  --target-slot production

echo "==> Confirming production"
for attempt in $(seq 1 20); do
  if curl -fsS --max-time 10 "https://${APP_NAME}.azurewebsites.net/api/health" | grep -q '"status":"ok"'; then
    echo "    live"
    exit 0
  fi
  sleep 10
done

# The previous build is now sitting in the staging slot, so rolling back is a
# swap rather than a rebuild.
echo "!!! Production is unhealthy after the swap. Roll back with:" >&2
echo "    az webapp deployment slot swap -g $RESOURCE_GROUP -n $APP_NAME --slot staging --target-slot production" >&2
exit 1
