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
# Production dependencies only: roughly a third of the size, and a smaller
# artifact is a faster slot warm-up.
npm ci --omit=dev
zip -qr build.zip \
  dist node_modules package.json package-lock.json \
  drizzle scripts db lib startup.sh \
  alias-hooks.mjs register-alias.mjs
# Put the dev dependencies back, or the next local command fails confusingly.
npm ci

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
