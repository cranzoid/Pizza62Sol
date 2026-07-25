FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV WRANGLER_LOG_PATH=/tmp/wrangler.log

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["npx", "wrangler", "dev", "--config", "dist/server/wrangler.json", "--ip", "0.0.0.0", "--port", "3000", "--inspector-ip", "127.0.0.1", "--inspector-port", "9229", "--persist-to", "/tmp/pizza62-state", "--show-interactive-dev-session", "false", "--log-level", "info"]
