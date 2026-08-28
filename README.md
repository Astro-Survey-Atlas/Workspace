# Astro Survey Atlas (Workspace)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=22.13](https://img.shields.io/badge/Node->=22.13-brightgreen.svg)](package.json)
[![Vite: ^8.1.5](https://img.shields.io/badge/Vite-^8.1.5-blueviolet.svg)](package.json)

> **Atlas** is the user-facing interactive data exploration workspace in the Astro Survey Atlas ecosystem. It provides the central sky-mapping dashboard, local asset registration, credential management, file connectors, and task orchestration.

---

## 🗺️ System Integration & Boundaries

The Astro Survey Atlas ecosystem consists of three sibling repositories designed around a **deterministic-first** rule. Scientific calculations (catalog parsing, coordinate validation, HEALPix cell rasterization, and MOC generation) are handled entirely in tested TypeScript/Python code, completely decoupled from LLMs.

```
       +-----------------------------------------------+
       |          Astro-Survey-Atlas-Assets            |
       |  (Public Survey metadata & coverage packages) |
       +-----------------------------------------------+
                               |
                               |  1. Synchronizes Resource Package v3
                               |     (manifests, hash verifications, MOCs)
                               v
+--------------------------------------------------------------+
|                  Astro-Survey-Atlas-Workspace                |
|                    (Atlas - This Repository)                 |
+--------------------------------------------------------------+
|  - React/TS & Aladin Lite v3 Sky Dashboard                   |
|  - Local Catalog registry, Connectors (S3/Local/JDBC)        |
|  - Local scan engine & Workspace-owned Elasticsearch (ES)    |
|  - Task history tracker & SQLite/Postgres metadata store     |
+--------------------------------------------------------------+
            ^                                      |
            |                                      | 2. Submits K8s ScanRequest
            | 4. Imports Evidence                  |    (ScanPlan v2)
            |    (MOC, pixel counts, run logs)      |
            |                                      v
       +-----------------------------------------------+
       |          Astro-Survey-Atlas-Warehouse         |
       |  (K8s Operator & high-throughput S3 scanner)  |
       +-----------------------------------------------+
```

### Component Responsibility Matrix

| Feature / Responsibility | **Assets** 📦 | **Warehouse** ⚙️ | **Workspace (Atlas)** 🖥️ |
|:---|:---:|:---:|:---:|
| **Public Survey Coverage & Metadata** | **Authoritative Owner** | ❌ None | Read-only Sync (v3 Packages) |
| **User Asset Registry & Metadata** | ❌ None | ❌ None | **Authoritative Owner** |
| **Local Scanning & local ES indexing** | ❌ None | ❌ None | **Authoritative Owner** |
| **Remote S3/OSS High-throughput Scan** | ❌ None | **Execution & Operator** | Task Submission & Evidence Import |
| **天球 UI (Aladin Lite v3 Explorer)** | ❌ None | ❌ None | **Authoritative Owner** |
| **Credentials & Secrets Management** | ❌ None | Short-term token consumer | Secure secret store & delegation |
| **Agent / MCP Server Integration** | ❌ None | ❌ None | **Authoritative Owner** |

---

## ✨ Features

* **🌌 interactive Celestial Explorer**: Integrates **Aladin Lite v3** for viewing celestial coordinates (ICRS), overlaying HEALPix grids, and visualizing MOC (Multi-Order Coverage) layers from both public catalogs and user assets.
* **📂 User Asset Registry**: Add, inspect, filter, edit, and delete private data assets (星表, 图像, 光谱, Cube, 时序) with normalized survey/release labels.
* **🔌 Flexible Connectors**: Register data sources (Local filesystem, Amazon S3, Ali OSS, JDBC) and run structural sanity/connection checks.
* **🔍 Deterministic Local Scanner**: Parse CSV files locally, validate RA/Dec coordinates, build nesting HEALPix indexes, and generate IVOA FITS MOC files via a pinned Python MOC Core wrapper.
* **⚡ Optional Warehouse Remote Scan**: Delegate massive S3/OSS catalog scans to Warehouse via a custom `ScanRequest` CRD, importing file evidences and MOC projections upon completion.
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
│   └── storage/            # Metadata persistence (SQLite / Postgres)
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
* **Node.js**: `>= 22.13` (API server uses modern ESM features)
* **Python**: `3.10+` with `pip` (required by the scientific MOC Core CLI wheel)
* **Elasticsearch**: `8.x` (Workspace-owned search plane)
* **SQLite / PostgreSQL** (SQLite is configured by default)

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

# In Terminal 2: Run the Vite frontend server (proxies /api to port 3000)
npm run dev:viewer
```
Open `http://localhost:5173` in your browser.

---

## 🐳 Docker Compose Deployment

The Compose stack spins up the Express server (SQLite) along with a dedicated, isolated Workspace Elasticsearch.

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

## ☸️ Kubernetes (k3s) Deployment

The production deployment manifest targets k3s under the `astro-data-workspace` namespace.

```bash
# 1. Build the Docker image
docker build -t ay-dev/astro-data-workspace-mcp:latest .

# 2. Apply the manifest
kubectl apply -f deploy/k3s.yaml

# 3. Wait for the roll-out to complete
kubectl -n astro-data-workspace rollout status deployment/astro-data-workspace-mcp
```
* **Ingress endpoint**: `http://astro.workspace.dev.72602.space:32080/`
* **Direct NodePort access**: Port `32082` (maps directly to container port `3000`)

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
