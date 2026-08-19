# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The migration job runs `scripts/migrate.ts` from source through Node's
# type-stripping loader, so it needs the schema SQL, the seed modules it imports,
# and the path-alias hook — not just the bundled server.
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/db ./db
COPY --from=build /app/lib ./lib
COPY --from=build /app/alias-hooks.mjs /app/register-alias.mjs ./

USER node
EXPOSE 3000

# vinext's production server: a plain Node HTTP server that binds 0.0.0.0 and
# honours PORT. Invoked directly rather than through npx so the container never
# reaches the network to start.
CMD ["node", "node_modules/vinext/dist/cli.js", "start"]
