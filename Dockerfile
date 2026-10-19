# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.22.0-alpine3.24@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
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
