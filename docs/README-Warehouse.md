# Astro Survey Atlas (Warehouse)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Kubernetes: >=1.28](https://img.shields.io/badge/Kubernetes->=1.28-blue.svg)](deploy/operator.yaml)
[![Elasticsearch: 8.x](https://img.shields.io/badge/Elasticsearch-8.x-yellowgreen.svg)](package.json)

> **Warehouse** is the optional, high-performance remote scanning operator and execution engine in the Astro Survey Atlas ecosystem. Implemented as a Kubernetes Custom Operator, it processes massive datasets stored on remote S3/OSS objects, index coordinates, generates FITS MOC files, and populates the Warehouse-owned Elasticsearch (ES).

---

## 🗺️ Product Boundary & Contract

Warehouse is designed strictly as an **asynchronous scan executor**. It has no user interface, does not manage user asset metadata, and has no direct knowledge of workspace-local credentials. 

### Component Responsibility Matrix

| Feature / Responsibility | **Assets** 📦 | **Warehouse** ⚙️ (This Repository) | **Workspace (Atlas)** 🖥️ |
|:---|:---:|:---:|:---:|
| **Public Survey Coverage & Metadata** | **Authoritative Owner** | ❌ None | Read-only Sync (v3 Packages) |
| **User Asset Registry & Metadata** | ❌ None | ❌ None | **Authoritative Owner** |
| **Local Scanning & local ES indexing** | ❌ None | ❌ None | **Authoritative Owner** |
| **Remote S3/OSS High-throughput Scan** | ❌ None | **Execution & Operator** | Task Submission & Evidence Import |
| **天球 UI (Aladin Lite v3 Explorer)** | ❌ None | ❌ None | **Authoritative Owner** |
| **Credentials & Secrets Management** | ❌ None | Short-term token consumer | Secure secret store & delegation |

### Key Contracts

1. **ScanRequest CRD**: Submitted by Workspace to trigger scans. Uses CRD version `atlas.zhejianglab.org/v1alpha1` and requires `ScanPlan` v2.
2. **Credential Isolation**: Temporary Basic Auth credentials from `ASTRO_WAREHOUSE_ES_URL` are removed from HTTP query strings, stored in a short-term Kubernetes Secret, and injected into the scanner via environment variables (`usernameEnv` / `passwordEnv`).
3. **Tracking & Isolation Labels**: To prevent task confusion, Workspace and Warehouse jobs must use matching label keys, differentiated by their caller labels:
   - `atlas.zhejianglab.org/track-caller`: `workspace` (for user jobs) or `assets` (for public jobs).
   - `atlas.zhejianglab.org/track-task-kind`: `user-scan` or `user-coverage`.
4. **Isolated Search Plane**: Warehouse writes results to its dedicated `ast_*` indices (`ast_layer_index_v1`, `ast_file_index_v1`, `ast_coverage_index_v1`), never sharing them with Workspace `astro_*` indices.

---

## ✨ Features

* **☸️ Custom Kubernetes Operator**: Automatically listens for `ScanRequest` objects across active namespaces (e.g. `atlas-warehouse`, `astro-data-workspace`) and manages life cycle state machines.
* **⚡ High-throughput Object Scanner**: Performs distributed file listing and reads range headers for FITS files over S3, Ali OSS, or compatible object stores.
* **🪐 HEALPix Coordinate Compiler**: Parses coordinate metadata (RA, Dec, Frame, Units) from tabular files, maps celestial geometries, and yields spatial indices without storing full file rows.
* **🔒 Strict Namespace Security**: Executes scanning jobs inside the caller's namespace, using namespace-scoped service accounts and temporary volume mounts for scanning evidence (Evidence PVC).

---

## 📂 Project Structure

```text
/home/aaron/Repo/Astro-Survey-Atlas-Warehouse/
├── deploy/                 # Kubernetes deployment manifests
│   ├── crds/               # Custom Resource Definitions (ScanRequest)
│   ├── operator.yaml       # Operator deployment & Role-Based Access Control (RBAC)
│   └── configmap.yaml      # Scanner default templates & plan versions
├── src/                    # Go/Python code for Operator and Scanner
│   ├── operator/           # Controller loop monitoring ScanRequest CRDs
│   ├── scanner/            # S3 file crawler and CSV parser
│   └── healpix_index/      # Coordinate projection and pixel calculations
└── docs/                   # Specifications for scan-plan and operator contracts
```

---

## ☸️ CRD Spec Example (ScanRequest)

Here is a sample `ScanRequest` custom resource representing a Workspace remote user scan:

```yaml
apiVersion: atlas.zhejianglab.org/v1alpha1
kind: ScanRequest
metadata:
  name: user-asset-scan-sample
  namespace: astro-data-workspace
  labels:
    app.kubernetes.io/managed-by: astro-data-workspace
    atlas.zhejianglab.org/track-caller: workspace
    atlas.zhejianglab.org/track-task-kind: user-scan
    atlas.zhejianglab.org/track-asset: user-asset-123
    atlas.zhejianglab.org/track-connector: connector-fd599c33
spec:
  plan:
    version: 2
    path: "catalogs/sample.csv"
    allowedSuffixes:
      - ".csv"
    spatial:
      mode: "catalog-radec"
      coordinateFrame: "ICRS"
      coverageRole: "object_presence"
      dataOrigin: "catalog"
      sourceTier: "user_file_derived"
      maxOrder: 10
      raColumn: "RA"
      decColumn: "DEC"
```

---

## 🚀 Local Operator Testing & Validation

### 1. Register CRD schema
Apply the `ScanRequest` CRD to your local Kubernetes dev cluster (e.g. k3s / minikube):
```bash
kubectl apply -f deploy/crds/atlas.zhejianglab.org_scanrequests.yaml
```

### 2. Run the Operator Locally
Set environment variables and launch the controller loop:
```bash
# Watch the development namespace
export WATCH_NAMESPACES=astro-data-workspace

# Run the controller loop (written in Go / Python)
go run cmd/operator/main.go
```

### 3. Verify Scanning Execution
Create a test secret containing mock S3 credentials, submit a mock `ScanRequest`, and verify that scanning pods are successfully spawned:
```bash
kubectl apply -f test/fixtures/mock-secret.yaml
kubectl apply -f test/fixtures/mock-scanrequest.yaml

# Check operator pod logs
kubectl logs -l app=astro-warehouse-operator

# Check spawned scanner pods
kubectl get pods -n astro-data-workspace -w
```
Once the scan completes successfully, the Operator updates the `ScanRequest` status to `Completed`, writes evidence logs, and records progress in the `ast_*` Elasticsearch indexes.
