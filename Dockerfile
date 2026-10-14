# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG ROOTSET_SOURCE_REVISION=unknown
FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
ENV CI=true NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@11.5.3
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm typecheck && pnpm build

FROM ${NODE_IMAGE} AS backend
ARG ROOTSET_SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/avgeek-oss/rootset" \
      org.opencontainers.image.revision="${ROOTSET_SOURCE_REVISION}"
WORKDIR /app
ENV NODE_ENV=production TZ=UTC
RUN groupadd --gid 10001 rootset && useradd --uid 10001 --gid rootset --no-create-home rootset \
    && install -d -m 0700 -o rootset -g rootset /var/lib/rootset/artifact-spool
COPY --from=build --chown=rootset:rootset /workspace/dist /app/dist
COPY --from=build --chown=rootset:rootset /workspace/packages/database/migrations /app/migrations
COPY --from=build --chown=rootset:rootset /workspace/packages/database/upgrades /app/upgrades
USER 10001:10001

FROM backend AS runtime
CMD ["node", "dist/api.mjs"]

FROM backend AS worker
CMD ["node", "dist/worker.mjs"]

FROM ${NODE_IMAGE} AS web
ARG ROOTSET_SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/avgeek-oss/rootset" \
      org.opencontainers.image.revision="${ROOTSET_SOURCE_REVISION}"
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 TZ=UTC PORT=4300 HOSTNAME=0.0.0.0 NODE_OPTIONS=--max-http-header-size=196608
RUN groupadd --gid 10001 rootset && useradd --uid 10001 --gid rootset --no-create-home rootset
COPY --from=build --chown=rootset:rootset /workspace/apps/rootset-web/.next/standalone /app
COPY --from=build --chown=rootset:rootset /workspace/apps/rootset-web/.next/static /app/apps/rootset-web/.next/static
COPY --from=build --chown=rootset:rootset /workspace/apps/rootset-web/public /app/apps/rootset-web/public
COPY --from=build --chown=rootset:rootset /workspace/dist/notices /app/notices
USER 10001:10001
CMD ["node", "apps/rootset-web/server.js"]
