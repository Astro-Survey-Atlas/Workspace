# Astro Survey Atlas (Workspace)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node: >=22.15](https://img.shields.io/badge/Node->=22.15-brightgreen.svg)](package.json)
[![Vite: ^8.1.5](https://img.shields.io/badge/Vite-^8.1.5-blueviolet.svg)](package.json)

> **Atlas** is the user-facing interactive data exploration workspace in the Astro Survey Atlas ecosystem. It provides the central sky-mapping dashboard, local asset registration, credential management, file connectors, and task orchestration.

---

## Runtime

Workspace runs independently with one API, one scan worker, local SQLite and
its own Elasticsearch. It reads public survey packages from Assets. Warehouse
is a separate application and is not a runtime dependency.

```text
Assets public packages → Workspace API / Viewer / Agent / CLI
                              ↕                  ↕
                         local SQLite     owned Elasticsearch
                              ↕                  ↑
                         one scan worker ────────┘
                              ↓
                      local / S3 / OSS CSV and FITS
```

The API records scan commands without enumerating directories or reading
scientific files. The worker freezes the file inventory, validates source
versions, writes bounded batches and checkpoints progress. Positions, file
references and MOC must all succeed before the new version is published. Failed
or paused scans leave the previously published version available.

SQLite stores control records: assets, Connectors, scan status, Workflow runs,
Agent sessions and human decisions. Large scientific attributes and outputs stay
in referenced files. Elasticsearch contains only the position, file and image
footprint indices; it is not a second control-state store.

Startup uses the validated local public-catalog cache. Refresh it explicitly
with catalog sync; an unavailable Assets endpoint does not block a cached
Workspace from starting. Catalog/configuration snapshots retain the latest
three versions. Scientific evidence and Workflow artifacts are retained separately.

## ✨ Features

* **🌌 interactive Celestial Explorer**: Integrates **Aladin Lite v3** for viewing celestial coordinates (ICRS), overlaying HEALPix grids, and visualizing MOC (Multi-Order Coverage) layers from both public catalogs and user assets.
* **📂 User Asset Registry**: Add, inspect, filter, edit, and delete private data assets (星表, 图像, 光谱, Cube, 时序) with normalized survey/release labels.
* **🔌 Flexible Connectors**: Register data sources (Local filesystem, Amazon S3, Ali OSS, JDBC) and run structural sanity/connection checks.
* **🔍 Deterministic Local Scanner**: Read CSV, FITS tables and FITS image headers from local or S3/OSS sources, validate RA/Dec coordinates, build nesting HEALPix indexes, and generate IVOA FITS MOC files via a pinned Python MOC Core wrapper.
* **⏸️ Durable Scan Control**: Pause/resume/cancel/retry via the same API, UI and CLI. Scanning starts paused; interrupted runs require an explicit resume.
* **🤖 Agent & MCP Support**: Exposes workspace APIs as Model Context Protocol (MCP) tools, allowing LLM agents to inspect data assets and query coordinate boundaries.
* **🔔 Unified Toast Notifications**: A global notification deck (`#workspace-notification-deck`) that provides real-time progress for package sync, connector validation, scans, and system errors.

---

## 📂 Project Structure

```text
/home/aaron/Repo/Astro-Survey-Atlas-Workspace/
├── docs/                   # System architecture and frozen design boundaries
├── src/                    # Backend server (Express.js, TS)
│   ├── agent.ts            # Agent logic & Model Context Protocol tools
│   ├── astro-index.ts      # Workspace ES index creation & index mapping
│   ├── connectors.ts       # Connector schemas and connection test endpoints
│   ├── coverage-jobs.ts    # MOC compilation and geometry tasks
│   ├── http-server.ts      # Main Express application entry point
│   ├── local-scan.ts       # Local file scanner (CSV parsing, coordinate validation)
│   └── storage/            # Local SQLite metadata persistence
├── test/                   # Comprehensive unit, integration, and e2e tests
├── vendor/moc-core/        # Pinned Python moc-core adapter distribution
└── viewer/                 # Frontend client (Vite, TS, Aladin Lite v3)
    ├── index.html          # Main HTML frame
    └── src/
        ├── aladin-explorer.ts  # Aladin Lite wrapper & Sky representation layers
        ├── main.ts             # Shell coordinator, tab switching & toast deck
        └── styles.css          # Core workspace CSS stylesheet
```

---

## 🚀 Quick Start

### 1. Prerequisites
Ensure you have the following installed on your Linux machine:
* **Node.js**: `>= 22.15` (API server uses modern ESM features)
* **Python**: `3.10+` with `pip` (required by the scientific MOC Core CLI wheel)
* **Elasticsearch**: `8.x` (Workspace-owned search plane)
* **Local disk** for SQLite WAL and Elasticsearch; source files can remain on remote storage

### 2. Installation & Build
Clone the repository and install dependencies:
```bash
# Install dependencies using npmmirror to avoid network issues
npm ci --registry=https://registry.npmmirror.com

# Build the TypeScript Express backend and Vite frontend
npm run build
```

### 3. Local Development
Start the Express backend and the Vite development server in watch mode:

```bash
# In Terminal 1: Run the backend API server (listens on 127.0.0.1:3000)
npm run dev

# In Terminal 2: Run the separate scan worker after building
npm run scan:worker

# In Terminal 3: Run the Vite frontend server (proxies /api to port 3000)
npm run dev:viewer
```
Open `http://localhost:5173` in your browser.

---

## 🖥️ Windows Desktop (installer)

Download `Astro Survey Atlas Workspace-<version>-setup.exe` from
[GitHub Releases](https://github.com/Astro-Survey-Atlas/Workspace/releases) and run it
(Windows 10/11 x64, desktop only — no mobile). The installer bundles the API server,
the Viewer, and an embedded Python 3.11 with the MOC Core wheel, so no Node.js,
Python, or Elasticsearch expertise is required.

First launch opens a setup wizard:

1. **数据目录** — where the Workspace keeps its SQLite metadata and state (defaults to `%APPDATA%`).
2. **搜索后端（必选其一）**
   - **外部 Elasticsearch** — paste the ES URL and use 测试连接 to verify; or
   - **本地 Docker** — the launcher auto-detects Docker (manual path override available) and
     manages a dedicated `astro-workspace-search` container (Elasticsearch 8.18.0 + named volume).

Configuration is saved to `astro-workspace-desktop.json` in the app data folder; later
launches skip the wizard. Updates are delivered automatically via `electron-updater`
(GitHub Releases). Notes:

* The installer is not code-signed yet — SmartScreen may show a warning; choose
  「更多信息 → 仍要运行」.
* MOC generation uses the bundled Python; no system Python is needed.
* Logs: `%APPDATA%/astro-survey-atlas-workspace-desktop/logs/workspace-server.log`.

---

## 🐳 Docker Compose Deployment

The Compose stack spins up the Express server (SQLite) along with a dedicated, isolated Workspace Elasticsearch.

### End users (published image, no source tree needed)

Run the release stack straight from the public GitHub Container Registry —
nothing is built locally and only Docker is required:

```bash
ASTRO_PORT=8080 docker compose -f compose.release.yaml up -d

# Verify
curl http://127.0.0.1:8080/healthz
```

Then open `http://127.0.0.1:8080/`. Pin a released version instead of
`latest` for reproducibility:

```bash
ASTRO_WORKSPACE_IMAGE=ghcr.io/astro-survey-atlas/asa-workspace:<version> \
  docker compose -f compose.release.yaml up -d
```

Data persists in the named volumes `asa-workspace-state` (SQLite and
derived state) and `asa-workspace-search` (Elasticsearch data); both
survive `docker compose down` and are only removed with `down -v`.

### Developers (build from source)

### 1. Configure Local Data Bind
Copy the local compose override and set the absolute path to your local scientific datasets:
```bash
cp compose.local.example.yaml compose.local.yaml

# Set host directory containing your CSVs/FITS
export ASTRO_LOCAL_DATA_ROOT=/srv/astro-data
```

### 2. Launch Services
```bash
docker compose -f compose.yaml -f compose.local.yaml up -d
```
*The container runs as UID/GID `10001` with a read-only root filesystem and drops all Linux capabilities for maximum security.*

---

## ⎈ Helm

The chart installs one API, one worker and one owned Elasticsearch. Defaults
use `local-path` storage and keep scanning paused. API and worker share the same
node for SQLite WAL.

```bash
helm install asa ./charts/asa-workspace \
  --namespace asa-workspace --create-namespace
kubectl -n asa-workspace rollout status deployment/asa-workspace
kubectl -n asa-workspace port-forward svc/asa-workspace 3000:3000
curl http://127.0.0.1:3000/healthz
```

For an existing installation, follow [the migration procedure](docs/workspace-metadata-migration.md).
Keep original volumes until queries and historical downloads have been checked.
Chart options are documented in [the chart README](charts/asa-workspace/README.md).

---

## ☸️ Kubernetes (k3s) Deployment

Build and deploy the same chart to k3s; [the chart README](charts/asa-workspace/README.md)
describes local storage, mounts and the optional download worker. The dev endpoint
is `http://astro.workspace.dev.72602.space:32080/`.

For a local Viewer preview on port `4173`, point the Vite proxy at the k3s API
instead of its local default:

```bash
ASTRO_API_URL=http://astro.workspace.dev.72602.space:32080 npm run preview:viewer
```

The preview server is only a development frontend. The deployed Workspace
serves the Viewer and `/api` from the same Ingress/NodePort endpoint.

---

## 🧪 Testing & Validation

Workspace features a strict deterministic test suite covering coordinate validation, file scanning, mapping, and API endpoints.

```bash
# Run unit & integration tests
npm test

# Run Playwright end-to-end tests
npx playwright install
npm run test:e2e

# Run the complete validation cycle (Lint, Build, Test)
npm run validate
```
