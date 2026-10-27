# No apt layer: bullseye's archives went away with its LTS and broke the build (2026-10-03); the health check uses
# node's fetch instead of curl.
# Exact Node release: bump it for every Node security release (Node bundles its own CA store).
FROM node:22.23.4-bookworm-slim

WORKDIR /app

# Standalone npm install (not pnpm workspace): tiny dependency set, and a
# self-contained context keeps the image build independent of the monorepo lockfile.
COPY package*.json ./
RUN npm install --no-audit --no-fund --ignore-scripts

COPY src ./src
COPY tsconfig.json ./

RUN ./node_modules/.bin/tsc

RUN npm prune --production

RUN groupadd -r mcp && useradd -r -g mcp mcp
RUN chown -R mcp:mcp /app

ENV NODE_ENV=production
ENV PORT=8080

USER mcp

EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "dist/http.js"]
