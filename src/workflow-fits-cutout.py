#!/usr/bin/env python3

from __future__ import annotations

import json
import io
import re
import sys
import urllib.request
from collections import OrderedDict
from pathlib import Path
from typing import Any

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales


RANGE_BLOCK_BYTES = 1024 * 1024
RANGE_CACHE_BLOCKS = 8
MAX_READ_BYTES = 8 * 1024 * 1024
MAX_ARTIFACT_BYTES = 5 * 1024 * 1024
FITS_BLOCK_BYTES = 2880


class HttpRangeReader(io.RawIOBase):
    def __init__(self, url: str, size: int, token: str):
        super().__init__()
        if size < 1 or not token:
            raise ValueError("invalid_range_source")
        self._name = url
        self.size = size
        self._url = url
        self._token = token
        self._position = 0
        self._blocks: OrderedDict[int, bytes] = OrderedDict()
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @property
    def name(self) -> str:
        return self._name

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._position

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            position = offset
        elif whence == io.SEEK_CUR:
            position = self._position + offset
        elif whence == io.SEEK_END:
            position = self.size + offset
        else:
            raise ValueError("invalid_seek_origin")
        if position < 0:
            raise ValueError("negative_seek_position")
        self._position = position
        return position

    def read(self, size: int = -1) -> bytes:
        if self.closed:
            raise ValueError("I/O operation on closed file")
        if size is None or size < 0:
            size = self.size - self._position
        if size > MAX_READ_BYTES:
            raise OSError("unbounded_remote_read")
        remaining = min(size, max(0, self.size - self._position))
        chunks: list[bytes] = []
        while remaining:
            block_start = (self._position // RANGE_BLOCK_BYTES) * RANGE_BLOCK_BYTES
            block = self._block(block_start)
            offset = self._position - block_start
            count = min(remaining, len(block) - offset)
            if count <= 0:
                raise OSError("invalid_range_response")
            chunks.append(block[offset:offset + count])
            self._position += count
            remaining -= count
        return b"".join(chunks)

    def readinto(self, buffer: Any) -> int:
        content = self.read(len(buffer))
        buffer[:len(content)] = content
        return len(content)

    def _block(self, start: int) -> bytes:
        cached = self._blocks.get(start)
        if cached is not None:
            self._blocks.move_to_end(start)
            return cached
        end = min(self.size - 1, start + RANGE_BLOCK_BYTES - 1)
        request = urllib.request.Request(
            self._url,
            headers={
                "Range": "bytes=%d-%d" % (start, end),
                "X-ASA-FITS-Range-Token": self._token,
            },
        )
        with self._opener.open(request, timeout=30) as response:
            expected_range = "bytes %d-%d/%d" % (start, end, self.size)
            if response.status != 206 or response.headers.get("Content-Range") != expected_range:
                raise OSError("invalid_range_response")
            content = response.read(end - start + 1)
        if len(content) != end - start + 1:
            raise OSError("short_range_response")
        self._blocks[start] = content
        if len(self._blocks) > RANGE_CACHE_BLOCKS:
            self._blocks.popitem(last=False)
        return content


def _select_hdu(hdul: fits.HDUList, telescope: str):
    wanted = 0 if telescope == "euclid" else 1
    if wanted < len(hdul) and _has_image_data(hdul[wanted]):
        return hdul[wanted]
    for hdu in hdul:
        if _has_image_data(hdu):
            return hdu
    raise ValueError("missing_image_hdu")


def _has_image_data(hdu) -> bool:
    try:
        naxis = int(hdu.header.get("NAXIS", 0))
        extension = str(hdu.header.get("XTENSION", "")).strip().upper()
        if extension in ("BINTABLE", "TABLE") and not hdu.header.get("ZIMAGE", False):
            return False
        return naxis >= 2 and all(
            int(hdu.header.get("NAXIS%d" % axis, 0)) > 0
            for axis in range(1, naxis + 1)
        )
    except (TypeError, ValueError):
        return False


def _image_shape(hdu) -> tuple[int, ...]:
    shape = tuple(int(axis) for axis in (hdu.shape or ()))
    if len(shape) < 2:
        raise ValueError("invalid_image_dimensions")
    while len(shape) > 2:
        shape = shape[1:]
    return shape


def _pixel_scale_deg(header: fits.Header, wcs: WCS) -> float:
    for key in ("CD1_1", "CDELT1"):
        try:
            value = abs(float(header[key]))
            if value > 0:
                return value
        except (KeyError, TypeError, ValueError):
            pass
    try:
        scales = proj_plane_pixel_scales(wcs)
        positive = [abs(float(value)) for value in scales[:2] if float(value) > 0]
        if positive:
            return min(positive)
    except Exception:
        pass
    return 1.0 / 3600.0


def _cutout_from_hdu(hdu, wcs: WCS, ra_deg: float, dec_deg: float, size_deg: float):
    shape = _image_shape(hdu)
    x, y = wcs.world_to_pixel_values(ra_deg, dec_deg)[:2]
    scale = _pixel_scale_deg(hdu.header, wcs)
    half_size = max(1, int(size_deg / scale / 2.0))
    stamp_size = half_size * 2
    if stamp_size * stamp_size * 8 + FITS_BLOCK_BYTES > MAX_ARTIFACT_BYTES:
        raise ValueError("cutout_exceeds_artifact_limit")
    xmin = max(0, int(x) - half_size)
    xmax = min(shape[-1], int(x) + half_size)
    ymin = max(0, int(y) - half_size)
    ymax = min(shape[-2], int(y) + half_size)
    height = max(0, ymax - ymin)
    width = max(0, xmax - xmin)
    section_data = None
    if height and width:
        prefix = (0,) * (len(hdu.shape) - 2)
        section_data = np.asarray(hdu.section[prefix + (slice(ymin, ymax), slice(xmin, xmax))])
    if section_data is not None:
        dtype = section_data.dtype
    else:
        dtype = np.dtype({
            8: "uint8", 16: "int16", 32: "int32", 64: "int64", -32: "float32", -64: "float64"
        }.get(int(hdu.header.get("BITPIX", -32)), "float32"))
    output = np.zeros((stamp_size, stamp_size), dtype=dtype)
    if section_data is not None:
        output[:height, :width] = section_data

    header = hdu.header.copy()
    if "CRPIX1" in header:
        header["CRPIX1"] = float(header["CRPIX1"]) - xmin
    if "CRPIX2" in header:
        header["CRPIX2"] = float(header["CRPIX2"]) - ymin
    meta = {
        "has_overlap": bool(height and width),
        "stamp_size_px": stamp_size,
    }
    return fits.HDUList([fits.PrimaryHDU(data=output, header=header)]), meta


def _safe_token(value: Any, default: str) -> str:
    text = str(value or "").strip()
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text) if text else default


def execute(payload: dict[str, Any]) -> dict[str, Any]:
    run_id = str(payload["run_id"])
    telescope = str(payload["telescope"]).lower()
    band = str(payload["band"]).lower()
    size_deg = float(payload["size_deg"])
    output_root = Path(payload["output_root"]).resolve()
    results: list[dict[str, Any]] = []
    source = None
    if isinstance(payload.get("source_url"), str):
        source = HttpRangeReader(str(payload["source_url"]), int(payload["source_size"]), str(payload["source_token"]))
        fits_source = source
    else:
        fits_source = str(payload["source_path"])

    try:
        with fits.open(fits_source, memmap=False) as hdul:
            hdu = _select_hdu(hdul, telescope)
            wcs = WCS(hdu.header)
            for target in payload["targets"]:
                row_index = int(target["row_index"])
                obj_id = str(target["obj_id"])
                ra_deg = float(target["ra_deg"])
                dec_deg = float(target["dec_deg"])
                try:
                    cutout, meta = _cutout_from_hdu(hdu, wcs, ra_deg, dec_deg, size_deg)
                    output_dir = output_root / run_id / telescope / band
                    output_dir.mkdir(parents=True, exist_ok=True)
                    filename = (
                        f"row{row_index:06d}_obj_{_safe_token(obj_id, 'obj_na')}"
                        f"_tile_{_safe_token(target.get('tile_index'), 'tile_na')}"
                        f"_brick_{_safe_token(target.get('brickname'), 'brick_na')}"
                        f"_{telescope}_{band}.fits"
                    )
                    output_path = output_dir / filename
                    cutout.writeto(output_path, overwrite=True)
                    results.append({
                        "status": "ok",
                        "row_index": row_index,
                        "obj_id": obj_id,
                        "ra_deg": ra_deg,
                        "dec_deg": dec_deg,
                        "output_path": str(output_path),
                        "meta": meta,
                    })
                except Exception as error:
                    results.append({
                        "status": "error",
                        "row_index": row_index,
                        "obj_id": obj_id,
                        "ra_deg": ra_deg,
                        "dec_deg": dec_deg,
                        "error": type(error).__name__,
                    })
    finally:
        if source is not None:
            source.close()
    return {"results": results}


def main() -> None:
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("request_must_be_object")
    print(json.dumps(execute(payload), allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(f"{type(error).__name__}\n")
        sys.exit(1)
