import io
import json
import math
import sys

import numpy as np
from astropy.io import fits
from astropy.coordinates import SkyCoord
import astropy.units as units


from workflow_catalog_helpers import resolve_columns, json_value


def canonical_hit(row, columns, config, index):
    def value(field):
        column = columns.get(field)
        return json_value(row[column]) if column else None

    side = config["side"]
    hints = config.get("sourceHints") or {}
    tile_index = value("tileIndex")
    if tile_index is None or not str(tile_index).strip():
        tile_index = hints.get("tileIndex")
    brickname = value("brickname")
    if brickname is None or not str(brickname).strip():
        brickname = hints.get("brickname")
    object_id = value("id")
    has_source_id = object_id is not None and str(object_id).strip() != ""
    if object_id is None or str(object_id).strip() == "":
        object_id = "row_%s_%s" % (config["sourceKey"], index)
    if side == "desi" and brickname:
        suffix = ":%s" % index if has_source_id else ""
        object_id = "%s:%s%s" % (str(brickname).strip().lower(), str(object_id).strip(), suffix)
    result = {"OBJECT_ID" if side == "euclid" else "TARGETID": str(object_id).strip()}
    if side == "euclid":
        result["RIGHT_ASCENSION"] = value("ra")
        result["DECLINATION"] = value("dec")
    else:
        result["ra"] = value("ra")
        result["dec"] = value("dec")
    if value("magnitude") is not None:
        result["MAG_AUTO"] = value("magnitude")
    if value("classLabel") is not None:
        result["type"] = value("classLabel")
    for target, field_value in (
        ("fits_path", value("fitsPath")),
        ("TILE_INDEX", tile_index),
        ("BRICKNAME", brickname),
    ):
        if field_value is not None:
            result[target] = field_value
    for band, field in [("g", "imageG"), ("r", "imageR"), ("i", "imageI"), ("z", "imageZ")]:
        field_value = value(field)
        if field_value is not None:
            result["image_%s_path" % band] = field_value
    extra_fields = {}
    for alias, column in config.get("extraColumns", {}).items():
        field_value = json_value(row[column])
        if field_value is not None:
            extra_fields[alias] = field_value
    if extra_fields:
        result["asa_catalog_fields"] = extra_fields
    return result


def main():
    config = json.loads(sys.stdin.buffer.readline())
    content = sys.stdin.buffer.read()
    with fits.open(io.BytesIO(content), memmap=False) as hdus:
        selected = config.get("tableHdu")
        if isinstance(selected, int):
            table_hdu = hdus[selected]
        elif isinstance(selected, str):
            table_hdu = hdus[selected]
        else:
            table_hdu = next((hdu for hdu in hdus if getattr(getattr(hdu, "data", None), "names", None)), None)
        if table_hdu is None or not getattr(getattr(table_hdu, "data", None), "names", None):
            raise ValueError("FITS file does not contain a binary table HDU")

        names = list(table_hdu.data.names)
        columns = resolve_columns(names, config.get("columns") or {})
        ra_values = np.asarray(table_hdu.data[columns["ra"]], dtype=float)
        dec_values = np.asarray(table_hdu.data[columns["dec"]], dtype=float)
        valid = np.isfinite(ra_values) & np.isfinite(dec_values) & (dec_values >= -90) & (dec_values <= 90)
        indices = np.flatnonzero(valid)
        if len(indices):
            target = SkyCoord(ra=config["raDeg"] * units.deg, dec=config["decDeg"] * units.deg, frame="icrs")
            positions = SkyCoord(ra=ra_values[indices] * units.deg, dec=dec_values[indices] * units.deg, frame="icrs")
            inside = positions.separation(target).arcsec <= config["radiusArcsec"]
            indices = indices[inside]

        selected_indices = indices[:config["limit"]]
        rows = [canonical_hit(table_hdu.data[index], columns, config, int(index) + 1) for index in selected_indices]
        sys.stdout.write(json.dumps({"rows": rows, "rowsScanned": len(table_hdu.data)}, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write("%s\n" % type(error).__name__)
        sys.exit(1)
