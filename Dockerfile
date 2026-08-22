FROM node:22.22.1-bookworm-slim AS build

ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry=${NPM_REGISTRY}

COPY tsconfig.json tsconfig.viewer.json vite.config.ts ./
COPY src ./src
COPY viewer ./viewer
RUN npm run build && npm prune --omit=dev

FROM node:22.22.1-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    ASTRO_DATA_WAREHOUSE_ENABLED=false \
    ASTRO_LOCAL_SCAN_ENABLED=false \
    ASTRO_METADATA_STORE=sqlite \
    ASTRO_SQLITE_PATH=/state/workspace.sqlite \
    ASTRO_STATE_ROOT=/state \
    ASTRO_DATA_CATALOG_STATE=/state/data-catalog.json \
    ASTRO_CONNECTOR_STATE=/state/connectors.json \
    ASTRO_CONNECTOR_RUN_STATE=/state/connector-ingest-runs.json \
    ASTRO_WORKFLOW_ROOT=/state/workflow-runs \
    ASTRO_RESOURCE_CATALOG_URL=file:///state/assets-current/catalog.json \
    ASTRO_RESOURCE_SNAPSHOT_ROOT=/state \
    ASTRO_RESOURCE_PACKAGE_ROOT=/state/resource-packages \
    ASTRO_RESOURCE_PACKAGE_STATE=/state/resource-package-state.json \
    ASTRO_VIEWER_ROOT=/app/viewer

WORKDIR /app
RUN groupadd --gid 10001 astro \
    && useradd --uid 10001 --gid astro --no-create-home astro \
    && mkdir -p /state/workflow-runs /state/resource-packages /data/local \
    && chown -R astro:astro /state \
    && chmod 0555 /data/local
COPY --from=build --chown=astro:astro /app/node_modules ./node_modules
COPY --from=build --chown=astro:astro /app/dist/src ./dist
COPY --from=build --chown=astro:astro /app/dist/viewer ./viewer

USER 10001:10001
EXPOSE 3000
CMD ["node", "dist/http-server.js"]
