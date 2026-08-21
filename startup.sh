#!/bin/sh
# App Service startup.
#
# Two things happen here, in this order, and the order is the whole point:
# migrations run to completion before the server accepts a request. A revision
# that starts serving against a schema it expects and has not got produces errors
# that look like application bugs.
#
# `scripts/migrate.ts` is idempotent and takes a Postgres advisory lock, so it is
# safe when several instances start at once — the second waits for the first
# rather than racing it. That matters on a slot swap, where the staging and
# production instances overlap.
#
# `set -e` so a failed migration stops the container rather than letting it come
# up and serve against a half-applied schema. App Service will show the failure
# and keep the previous instance running.
set -e

echo "[startup] applying database migrations"
node --experimental-strip-types --import ./register-alias.mjs scripts/migrate.ts

echo "[startup] starting the server"
exec node node_modules/vinext/dist/cli.js start
