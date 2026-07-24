#!/usr/bin/env python3
"""Build a compact, deterministic redshift volume from DESI-COSMOS SPECZ."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import struct
from typing import Any

from astropy.constants import c
from astropy.cosmology import Planck18
from astropy.io import fits
import numpy as np


MAGIC = b"ASTRVOL1"
FORMAT_VERSION = 1
HEADER_BYTES = 32
FIELD_COUNT = 6
SHELL_LEVELS = (1, 2, 4, 8, 16, 32)
FILTER_DESCRIPTION = "SPECTYPE == GALAXY && QUALITY_Z == true && BEST_Z > 0 && finite(TARGET_RA, TARGET_DEC, BEST_Z)"
PRODUCER_VERSION = "0.5.0"


def sha256_file(path: Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_json(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def input_fingerprint(path: Path, role: str, media_type: str) -> dict[str, Any]:
    stat = path.stat()
    digest = sha256_file(path)
    modified_at = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "role": role,
        "uri": f"urn:sha256:{digest}",
        "fileName": path.name,
        "mediaType": media_type,
        "byteLength": stat.st_size,
        "modifiedAt": modified_at,
        "sha256": digest,
    }


def output_fingerprint(path: Path, role: str, artifact_id: str, media_type: str) -> dict[str, Any]:
    return {
        "role": role,
        "artifactId": artifact_id,
        "fileName": path.name,
        "mediaType": media_type,
        "byteLength": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def comoving_distance_planck18(redshift: np.ndarray, grid_size: int = 131_073) -> np.ndarray:
    """Integrate c/H0/E(z) on a dense deterministic grid without SciPy."""
    values = np.asarray(redshift, dtype=np.float64)
    if values.size == 0:
        return values.copy()
    if np.any(~np.isfinite(values)) or np.any(values < 0):
        raise ValueError("redshift must contain finite non-negative values")
    maximum = float(values.max())
    if maximum == 0:
        return np.zeros_like(values)
    grid = np.linspace(0.0, maximum, grid_size, dtype=np.float64)
    inverse_e = 1.0 / np.asarray(Planck18.efunc(grid), dtype=np.float64)
    increments = (inverse_e[:-1] + inverse_e[1:]) * 0.5 * np.diff(grid)
    integral = np.concatenate((np.zeros(1, dtype=np.float64), np.cumsum(increments)))
    hubble_distance_mpc = c.to_value("km/s") / Planck18.H0.to_value("km/(Mpc s)")
    return np.interp(values, grid, integral) * hubble_distance_mpc


def circular_mean_deg(values: np.ndarray) -> float:
    radians = np.deg2rad(values)
    return float(np.rad2deg(np.arctan2(np.sin(radians).mean(), np.cos(radians).mean())) % 360.0)


def write_binary(
    output_path: Path,
    ra_deg: np.ndarray,
    dec_deg: np.ndarray,
    best_z: np.ndarray,
    z_err: np.ndarray,
    distance_mpc: np.ndarray,
    target_id: np.ndarray,
) -> int:
    count = int(ra_deg.size)
    temporary = output_path.with_suffix(".tmp")
    with temporary.open("wb") as handle:
        handle.write(struct.pack("<8sIIIIII", MAGIC, FORMAT_VERSION, count, FIELD_COUNT, HEADER_BYTES, 0, 0))
        for values in (ra_deg, dec_deg, best_z, z_err, distance_mpc):
            handle.write(np.asarray(values, dtype="<f4").tobytes(order="C"))
        padding = (-handle.tell()) % np.dtype("<u8").itemsize
        if padding:
            handle.write(b"\0" * padding)
        handle.write(np.asarray(target_id, dtype="<u8").tobytes(order="C"))
    temporary.replace(output_path)
    return output_path.stat().st_size


def build_volume(
    input_path: Path,
    output_directory: Path,
    volume_id: str = "desi-cosmos-v2",
    name: str = "DESI COSMOS Redshift Volume",
    domain_max_mpc: float = 6000.0,
) -> dict[str, Any]:
    started_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    source_fingerprint = input_fingerprint(input_path, "source-catalog", "application/fits")
    code_sha256 = sha256_file(Path(__file__).resolve())
    parameters = {
        "hdu": "SPECZ",
        "filter": FILTER_DESCRIPTION,
        "cosmology": "Planck18",
        "domainMaxMpc": domain_max_mpc,
        "binaryFormat": "astro-volume-v1",
    }
    config_sha256 = sha256_json({
        "kind": "redshift-volume",
        "artifactId": volume_id,
        "producerVersion": PRODUCER_VERSION,
        "codeSha256": code_sha256,
        "inputSha256": source_fingerprint["sha256"],
        "parameters": parameters,
    })
    scan_run_id = f"{volume_id}-scan-{config_sha256[:16]}"
    output_directory.mkdir(parents=True, exist_ok=True)
    with fits.open(input_path, memmap=True) as hdus:
        data = hdus["SPECZ"].data
        source_row_count = len(data)
        ra_all = np.asarray(data["TARGET_RA"], dtype=np.float64)
        dec_all = np.asarray(data["TARGET_DEC"], dtype=np.float64)
        z_all = np.asarray(data["BEST_Z"], dtype=np.float64)
        z_err_all = np.asarray(data["ZERR"], dtype=np.float64)
        target_id_all = np.asarray(data["TARGETID"], dtype=np.uint64)
        quality = np.asarray(data["QUALITY_Z"], dtype=bool)
        spectra = np.char.strip(np.asarray(data["SPECTYPE"]).astype("U"))
        mask = (
            (spectra == "GALAXY")
            & quality
            & np.isfinite(ra_all)
            & np.isfinite(dec_all)
            & np.isfinite(z_all)
            & (z_all > 0)
        )
        ra_deg = ra_all[mask]
        dec_deg = dec_all[mask]
        best_z = z_all[mask]
        z_err = z_err_all[mask]
        target_id = target_id_all[mask]

    if ra_deg.size == 0:
        raise ValueError("SPECZ filter selected no rows")
    distance_mpc = comoving_distance_planck18(best_z)
    if float(distance_mpc.max()) > domain_max_mpc:
        raise ValueError("domain_max_mpc is smaller than the selected data extent")

    binary_path = output_directory / "points.bin"
    byte_length = write_binary(binary_path, ra_deg, dec_deg, best_z, z_err, distance_mpc, target_id)
    binary_sha256 = sha256_file(binary_path)
    shell_levels = []
    for shell_count in SHELL_LEVELS:
        counts, _ = np.histogram(distance_mpc, bins=np.linspace(0.0, domain_max_mpc, shell_count + 1))
        shell_levels.append({"shellCount": shell_count, "counts": [int(value) for value in counts]})

    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "id": volume_id,
        "name": name,
        "source": {
            "fileName": input_path.name,
            "hdu": "SPECZ",
            "sourceRowCount": source_row_count,
            "filter": FILTER_DESCRIPTION,
            "uri": source_fingerprint["uri"],
            "byteLength": source_fingerprint["byteLength"],
            "modifiedAt": source_fingerprint["modifiedAt"],
            "sha256": source_fingerprint["sha256"],
        },
        "coordinateFrame": "ICRS",
        "radialCoordinate": {
            "kind": "comoving_distance",
            "unit": "Mpc",
            "cosmology": "Planck18",
            "domainMinMpc": 0,
            "domainMaxMpc": domain_max_mpc,
            "dataMinMpc": float(distance_mpc.min()),
            "dataMaxMpc": float(distance_mpc.max()),
        },
        "pointCount": int(ra_deg.size),
        "coverage": {
            "raMinDeg": float(ra_deg.min()),
            "raMaxDeg": float(ra_deg.max()),
            "decMinDeg": float(dec_deg.min()),
            "decMaxDeg": float(dec_deg.max()),
            "centerRaDeg": circular_mean_deg(ra_deg),
            "centerDecDeg": float(dec_deg.mean()),
        },
        "redshift": {
            "min": float(best_z.min()),
            "max": float(best_z.max()),
            "median": float(np.median(best_z)),
        },
        "shellLevels": shell_levels,
        "binary": {
            "file": binary_path.name,
            "format": "astro-volume-v1",
            "byteLength": byte_length,
            "endianness": "little",
            "fields": ["raDeg", "decDeg", "bestZ", "zErr", "comovingDistanceMpc", "targetId"],
            "sha256": binary_sha256,
        },
        "provenance": {
            "scanRunId": scan_run_id,
            "configSha256": config_sha256,
        },
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    manifest_path = output_directory / "manifest.json"
    temporary_manifest = manifest_path.with_suffix(".tmp")
    temporary_manifest.write_text(json.dumps(manifest, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    temporary_manifest.replace(manifest_path)
    outputs = [
        output_fingerprint(binary_path, "point-volume", volume_id, "application/octet-stream"),
        output_fingerprint(manifest_path, "manifest", volume_id, "application/json"),
    ]
    input_id = source_fingerprint["uri"]
    scan_run = {
        "schemaVersion": 1,
        "id": scan_run_id,
        "kind": "redshift-volume",
        "status": "succeeded",
        "startedAt": started_at,
        "completedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "producer": {
            "name": "build_redshift_volume.py",
            "version": PRODUCER_VERSION,
            "gitCommit": os.environ.get("ASTRO_GIT_COMMIT") or None,
            "codeSha256": code_sha256,
        },
        "configSha256": config_sha256,
        "parameters": parameters,
        "inputs": [source_fingerprint],
        "outputs": outputs,
        "lineage": [
            {"from": input_id, "to": f"urn:sha256:{output['sha256']}", "relation": "derived_from"}
            for output in outputs
        ],
    }
    scan_run_path = output_directory / "scan-run.json"
    temporary_scan_run = scan_run_path.with_suffix(".tmp")
    temporary_scan_run.write_text(json.dumps(scan_run, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    temporary_scan_run.replace(scan_run_path)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--id", default="desi-cosmos-v2")
    parser.add_argument("--name", default="DESI COSMOS Redshift Volume")
    parser.add_argument("--domain-max-mpc", default=6000.0, type=float)
    arguments = parser.parse_args()
    manifest = build_volume(arguments.input, arguments.output, arguments.id, arguments.name, arguments.domain_max_mpc)
    print(json.dumps({
        "id": manifest["id"],
        "pointCount": manifest["pointCount"],
        "dataMaxMpc": manifest["radialCoordinate"]["dataMaxMpc"],
        "binaryBytes": manifest["binary"]["byteLength"],
    }))


if __name__ == "__main__":
    main()
