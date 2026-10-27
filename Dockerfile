# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
ARG ROOTSET_SOURCE_REVISION=unknown
FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
ENV CI=true NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@11.5.3
# Manifests first so the dependency layer is reused until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/rootset-api/package.json apps/rootset-api/
COPY apps/rootset-web/package.json apps/rootset-web/
COPY apps/rootset-worker/package.json apps/rootset-worker/
COPY packages/access/package.json packages/access/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/database/package.json packages/database/
COPY packages/email/package.json packages/email/
COPY packages/idempotency/package.json packages/idempotency/
COPY packages/identity/package.json packages/identity/
COPY packages/jobs/package.json packages/jobs/
COPY packages/oauth/package.json packages/oauth/
COPY packages/observability/package.json packages/observability/
COPY packages/table-storage/package.json packages/table-storage/
COPY packages/web-client/package.json packages/web-client/
RUN pnpm install --frozen-lockfile
COPY . .
# The host CI type-checks the same commit; the package build scripts run tsc.
RUN pnpm build

FROM ${NODE_IMAGE} AS backend
ARG ROOTSET_SOURCE_REVISION
LABEL org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/avgeek-oss/rootset" \
      org.opencontainers.image.revision="${ROOTSET_SOURCE_REVISION}"
WORKDIR /app
ENV NODE_ENV=production TZ=UTC
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && addgroup -g 10001 rootset && adduser -u 10001 -G rootset -D -H rootset \
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
LABEL org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/avgeek-oss/rootset" \
      org.opencontainers.image.revision="${ROOTSET_SOURCE_REVISION}"
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 TZ=UTC PORT=4300 HOSTNAME=0.0.0.0 NODE_OPTIONS=--max-http-header-size=196608
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && addgroup -g 10001 rootset && adduser -u 10001 -G rootset -D -H rootset
COPY --from=build --chown=rootset:rootset /workspace/apps/rootset-web/.next/standalone /app
COPY --from=build --chown=rootset:rootset /workspace/apps/rootset-web/.next/static /app/apps/rootset-web/.next/static
COPY --from=build --chown=rootset:rootset /workspace/apps/rootset-web/public /app/apps/rootset-web/public
COPY --from=build --chown=rootset:rootset /workspace/dist/notices /app/notices
USER 10001:10001
CMD ["node", "apps/rootset-web/server.js"]
