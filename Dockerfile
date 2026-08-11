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
    ASTRO_WORKSPACE_STATE=/state/registry.json \
    ASTRO_DATA_CATALOG_BOOTSTRAP=/app/bootstrap/catalogs.json \
    ASTRO_DATA_CATALOG_STATE=/state/data-catalog.json \
    ASTRO_CONNECTOR_BOOTSTRAP=/app/bootstrap/connectors.json \
    ASTRO_CONNECTOR_STATE=/state/connectors.json \
    ASTRO_RESOURCE_CATALOG_URL=file:///app/bootstrap/resource-packages/catalog.json \
    ASTRO_RESOURCE_PACKAGE_ROOT=/resource-packages \
    ASTRO_RESOURCE_PACKAGE_STATE=/state/resource-package-state.json \
    ASTRO_ALLOWED_ROOTS=/app/fixtures \
    ASTRO_VIEWER_ROOT=/app/viewer \
    ASTRO_SURVEY_FOOTPRINT_ROOT=/app/footprints

WORKDIR /app
RUN groupadd --gid 10001 astro \
    && useradd --uid 10001 --gid astro --no-create-home astro \
    && mkdir -p /state /resource-packages \
    && chown astro:astro /state /resource-packages
COPY --from=build --chown=astro:astro /app/node_modules ./node_modules
COPY --from=build --chown=astro:astro /app/dist/src ./dist
COPY --from=build --chown=astro:astro /app/dist/viewer ./viewer
COPY --chown=astro:astro bootstrap ./bootstrap
COPY --chown=astro:astro src/footprints ./footprints
COPY --chown=astro:astro test/fixtures ./fixtures

USER 10001:10001
EXPOSE 3000
CMD ["node", "dist/http-server.js"]
