# Astro Survey Atlas (Assets)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python: 3.10+](https://img.shields.io/badge/Python-3.10+-blue.svg)](requirements.lock)

> **Assets** is the authoritative service and repository for public survey/release metadata, public footprints generation, and scientific coordinate mapping. It publishes the verified **Resource Package v3** catalog consumed by Workspace (Atlas).

---

## 🗺️ Product Boundary & Contract

Assets is built to enforce a **package-first, read-only** boundary for public data. It has no user management, does not track private catalogs, does not store credentials, and has no sky maps.

### Component Responsibility Matrix

| Feature / Responsibility | **Assets** 📦 (This Repository) | **Warehouse** ⚙️ | **Workspace (Atlas)** 🖥️ |
|:---|:---:|:---:|:---:|
| **Public Survey Coverage & Metadata** | **Authoritative Owner** | ❌ None | Read-only Sync (v3 Packages) |
| **User Asset Registry & Metadata** | ❌ None | ❌ None | **Authoritative Owner** |
| **Local Scanning & local ES indexing** | ❌ None | ❌ None | **Authoritative Owner** |
| **Remote S3/OSS High-throughput Scan** | ❌ None | **Execution & Operator** | Task Submission & Evidence Import |
| **天球 UI (Aladin Lite v3 Explorer)** | ❌ None | ❌ None | **Authoritative Owner** |

### Key Contracts

1. **Resource Package v3**: Immutable ZIP distribution containing survey coverage:
   - `resource-package.json`: Contains catalog manifest, size, SHA-256 hash, and provenance metadata.
   - FITS MOC: Native HEALPix Multi-Order Coverage files describing the survey boundary.
2. **Assets MOC Core Adapter**: Authoritative scientific library (`astro_survey_moc_core`) written in Python, exposing a deterministic CLI contract for HEALPix pixel conversions.
3. **No Dynamic Workspace APIs**: Workspace reads only published packages. Assets does not provide dynamic query endpoints for workspace tasks.

---

## ✨ Features

* **📦 Resource Package v3 Packager**: Packages public celestial coverage into structured packages. Automatically validates manifests, file sizes, and SHA-256 hashes before distribution.
* **🪐 Authoritative MOC Core (`astro_survey_moc_core`)**:
  - `fits-wcs`: Reads image WCS headers and computes image boundary polygons.
  - `catalog-radec`: Reads ICRS RA/Dec table fields and yields coverage grids using standard NESTED HEALPix projection.
  - `nested-healpix`: Decodes raw pixel arrays and validates grid ordering.
* **📜 Verified Provenance Engine**: Standardizes multi-survey coordinate systems (ICRS), enforcing `maxOrder=10` (query resolution order 8, preview resolution order 4).
* **🔬 Rigorous Geometry Auditing**: Compiles footprints with explicit criteria (e.g. `TILE_COMPLETENESS` for DESI, DS9 Region polygons for Euclid Q1) to verify scientific evidence before publication.

---

## 📂 Project Structure

```text
/home/aaron/Repo/Astro-Survey-Atlas-Assets/
├── artifacts/              # Published Resource Packages, manifests, and build indices
│   ├── public-survey-footprints/
│   │   ├── raw/            # Raw CDS, Euclid, and DESI geometries
│   │   └── moc-core/       # Authoritative astro_survey_moc_core wheels
├── src/                    # Package compiler and validator scripts
│   ├── build-package.py    # Combines FITS MOCs and manifests into Resource Packages
│   ├── validate-v3.py      # Strict manifest validator (SHA-256, coordinate formats)
│   └── moc_core/           # Python scientific library (packaged as wheel)
└── requirements.lock       # Pinned dependencies for scientific libs
```

---

## 🚀 Package Compilation & Local Testing

### 1. Prerequisites
Ensure you have Python `3.10+` and `pip` installed.

### 2. Scientific Environment Setup
Install the MOC Core scientific package in edit mode or install the built wheel:
```bash
# Install development dependencies
pip install -r requirements.lock

# Build the scientific MOC Core wheel
python setup.py bdist_wheel
```

### 3. Build a Resource Package v3
Run the packaging compiler to bundle a public survey release (e.g., Euclid Q1):
```bash
python src/build-package.py \
  --survey euclid \
  --release q1 \
  --geometry artifacts/public-survey-footprints/raw/geometry/q1_region_files.zip \
  --output artifacts/public-survey-packages/
```

### 4. Validate the Packages
Run the strict contract validation script to verify package integrity before publication:
```bash
python src/validate-v3.py \
  --package-dir artifacts/public-survey-packages/ \
  --catalog artifacts/public-survey-footprints/catalog.json
```
The validator checks:
* Zip integrity and file-level SHA-256 hashes.
* Manifest-declared metadata completeness.
* Coordinate validation (RA `[0,360)`, Dec `[-90,90]`) inside FITS MOC files.
* HEALPix order limits (must match NESTED coordinate constraints, `maxOrder <= 10`).
