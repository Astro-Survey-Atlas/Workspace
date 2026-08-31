FROM python:3.11-slim-bookworm AS moc-core

# Assets publishes the scientific implementation. Workspace vendors only the
# pinned wheel and dependency lock so production can generate user MOCs without
# carrying a second geometry implementation.
COPY vendor/moc-core/requirements.lock /tmp/moc-core/requirements.lock
COPY vendor/moc-core/astro_survey_moc_core-1.0.0-py3-none-any.whl /tmp/moc-core/
RUN python -m pip install --no-cache-dir --ignore-installed --prefix=/opt/moc-core \
    --requirement /tmp/moc-core/requirements.lock \
    /tmp/moc-core/astro_survey_moc_core-1.0.0-py3-none-any.whl

FROM node:22.22.1-bookworm-slim AS build

ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry=${NPM_REGISTRY}

COPY tsconfig.json tsconfig.viewer.json vite.config.ts ./
COPY src ./src
COPY viewer ./viewer
COPY packages ./packages
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
    ASTRO_MOC_CORE_CLI="python3 -m astro_survey_moc_core.cli" \
    PYTHONPATH=/usr/local/lib/python3.11/site-packages:/usr/local/lib/python3.11/dist-packages \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    PYTHONUNBUFFERED=1 \
    XDG_CACHE_HOME=/tmp \
    ASTRO_VIEWER_ROOT=/app/viewer

WORKDIR /app
RUN apt-get update \
    && apt-get install --no-install-recommends --yes python3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 astro \
    && useradd --uid 10001 --gid astro --no-create-home astro \
    && mkdir -p /state/workflow-runs /state/resource-packages /data/local \
    && chown -R astro:astro /state \
    && chmod 0555 /data/local
COPY --from=moc-core /opt/moc-core /usr/local
COPY --from=build --chown=astro:astro /app/node_modules ./node_modules
COPY --from=build --chown=astro:astro /app/dist/src ./dist
COPY --from=build --chown=astro:astro /app/packages/cli/dist ./packages/cli/dist
COPY --from=build --chown=astro:astro /app/dist/viewer ./viewer

USER 10001:10001
EXPOSE 3000
CMD ["node", "dist/http-server.js"]
