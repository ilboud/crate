# syntax=docker/dockerfile:1

# Build stage — compiles the server and bundles the web app.
FROM node:20-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 ships prebuilds for most platforms but falls back to
# compiling, which needs a toolchain. Synology units are x86_64 or ARM; both
# are covered, but keep the toolchain so a fallback build succeeds.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build

# Drop dev dependencies for the runtime image.
RUN npm prune --omit=dev

# Runtime stage.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/package.json ./package.json

# Mounted volumes; created here so the app starts cleanly on a fresh host.
RUN mkdir -p /data /covers && chown -R node:node /data /covers /app
USER node

ENV DB_PATH=/data/collection.db \
    COVERS_DIR=/covers \
    WEB_DIR=/app/web/dist \
    PORT=8080 \
    HOST=0.0.0.0

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server/index.js"]
