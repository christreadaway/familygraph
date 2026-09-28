# Family Graph container image. One Node process serving the API and the
# built dashboard on 3500 (server/index.js). Built for on-prem/edge deploys
# (arm64 primary, amd64 secondary); the compose/bare-metal install in the
# README keeps working unchanged.
#
#   docker build -t familygraph .
#   docker run -v fgdata:/data -p 127.0.0.1:3500:3500 familygraph
#
# Every dependency install below runs through Socket Firewall, the same
# guard the preinstall hook enforces for dev installs (CONTRIBUTING.md).
# sfw itself is installed globally first; the global install has no
# preinstall guard to satisfy and is the one documented bootstrap step.
ARG BASE=docker.io/library/node:20-slim

# ── client bundle (Vite/React dashboard, served from client/dist) ──────────
FROM ${BASE} AS client
RUN npm install -g sfw
WORKDIR /app
# client's preinstall guard resolves ../scripts/preinstall-sfw-check.js
COPY scripts ./scripts
COPY client/package*.json ./client/
RUN cd client && SFW=1 sfw npm ci
# npm has a long-standing hole installing platform-native optional deps
# (npm/cli#4828): under emulated cross-arch builds `npm ci` can complete
# without the rollup native binding for the target arch, and `vite build`
# then dies with MODULE_NOT_FOUND on @rollup/rollup-linux-<arch>-gnu (seen
# on the first arm64 CI build of this file). Installing the matching
# binding explicitly is idempotent when npm already got it right.
RUN cd client && SFW=1 sfw npm install --no-save "@rollup/rollup-linux-$(node -p process.arch)-gnu"
COPY client ./client
RUN cd client && npm run build

# ── server runtime deps (better-sqlite3 needs the node-gyp toolchain) ──────
FROM ${BASE} AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g sfw
WORKDIR /app
COPY scripts ./scripts
COPY package*.json ./
RUN SFW=1 sfw npm ci --omit=dev

# ── runtime ─────────────────────────────────────────────────────────────────
FROM ${BASE}
ENV NODE_ENV=production
# All state (SQLite db, secret.key, backups, watch/out dirs) lives under the
# home dir; mount a volume here. server/crypto/secret.js generates secret.key
# (0600) on first boot, so a fresh container needs no seeded secret.
ENV FAMILY_GRAPH_HOME=/data
# The bare-metal default is loopback-only. In a container the port must be
# reachable on the container interface for any consumer (publish it bound to
# 127.0.0.1, or keep it cluster-internal, per your posture); the /api/safe
# surface stays loopback-guarded in the app regardless of bind.
ENV FAMILY_GRAPH_BIND=0.0.0.0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=client /app/client/dist ./client/dist
COPY package.json ./
COPY server ./server
COPY bin ./bin
EXPOSE 3500
CMD ["node", "server/index.js"]
