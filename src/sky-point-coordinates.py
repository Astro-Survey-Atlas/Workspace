"""Transform private FITS header evidence to ICRS positions without opening science arrays."""
import json
import math
import sys
from astropy.io import fits
from astropy.wcs import WCS
from astropy.coordinates import SkyCoord
import astropy.units as u

AUXILIARY = {"ERR", "ERROR", "DQ", "MASK", "WHT", "WEIGHT", "VAR", "VARIANCE", "CONTEXT", "CTX"}

def header_for(record):
    header = fits.Header.fromstring(record["header"], sep="")
    primary = fits.Header.fromstring(record.get("primary_header", record["header"]), sep="")
    for key in ("RADESYS", "RADECSYS", "EQUINOX"):
        if key not in header and key in primary:
            header[key] = primary[key]
    # The replay input is from an explicitly ICRS Workspace coverage snapshot.
    if "RADESYS" not in header and "RADECSYS" not in header and "EQUINOX" not in header:
        header["RADESYS"] = "ICRS"
    return header, primary

def image_position(record):
    header, _ = header_for(record)
    if str(header.get("EXTNAME", "")).upper().strip() in AUXILIARY:
        return None
    if "TABLE" in str(header.get("XTENSION", "")).upper():
        return None
    width, height = int(header.get("NAXIS1", 0)), int(header.get("NAXIS2", 0))
    if int(header.get("NAXIS", 0)) < 2 or width <= 0 or height <= 0:
        return None
    wcs = WCS(header).celestial
    if not wcs.has_celestial:
        return None
    center_pixel = ((width - 1) / 2, (height - 1) / 2)
    center = wcs.pixel_to_world(*center_pixel).icrs
    samples = max(64, min(4096, math.ceil(2 * (width + height) / 32)))
    edge = [i / samples for i in range(samples + 1)]
    x = [t * (width - 1) for t in edge] + [width - 1] * samples + [(1 - t) * (width - 1) for t in edge] + [0] * samples
    y = [0] * (samples + 1) + [t * (height - 1) for t in edge[1:]] + [height - 1] * (samples + 1) + [(1 - t) * (height - 1) for t in edge[1:]]
    boundary = SkyCoord(*wcs.pixel_to_world_values(x, y), unit="deg", frame="icrs")
    ras = boundary.ra.deg
    decs = boundary.dec.deg
    angular_steps = boundary[:-1].separation(boundary[1:]).deg
    margin = max(float(max(angular_steps, default=0.0)) * 2, 1 / 3600)
    dec_min = max(-90.0, float(min(decs)) - margin)
    dec_max = min(90.0, float(max(decs)) + margin)
    result = dict(record)
    result.update(ra_deg=float(center.ra.deg) % 360, dec_deg=float(center.dec.deg),
                  position_role="image_center", position_method="astropy_wcs", coordinate_frame="ICRS")
    if dec_min <= -90 or dec_max >= 90:
        result["footprint_bounds"] = [[0.0, 360.0, dec_min, dec_max]]
    else:
        center_ra = float(center.ra.deg) % 360
        unwrapped = [center_ra + ((float(ra) - center_ra + 180) % 360 - 180) for ra in ras]
        cos_dec = max(math.cos(math.radians(max(abs(dec_min), abs(dec_max)))), 1e-6)
        ra_margin = min(180.0, margin / cos_dec)
        ra_min = min(unwrapped) - ra_margin
        ra_max = max(unwrapped) + ra_margin
        if ra_max - ra_min >= 360:
            result["footprint_bounds"] = [[0.0, 360.0, dec_min, dec_max]]
        else:
            left = ra_min % 360
            right = ra_max % 360
            result["footprint_bounds"] = [[left, right, dec_min, dec_max]] if left <= right else [
                [0.0, right, dec_min, dec_max], [left, 360.0, dec_min, dec_max]
            ]
    return result

def pointing_position(record):
    header, primary = header_for(record)
    for ra_key, dec_key in (("RA_TARG", "DEC_TARG"), ("RA", "DEC"), ("RA_DEG", "DEC_DEG")):
        if ra_key in primary and dec_key in primary:
            frame = str(primary.get("RADESYS", primary.get("RADECSYS", "ICRS"))).lower().strip()
            if frame not in ("icrs", "fk5", "fk4"):
                raise ValueError("unsupported pointing coordinate frame " + frame)
            kwargs = {"equinox": ("B" if frame == "fk4" else "J") + str(primary.get("EQUINOX", 2000))} if frame != "icrs" else {}
            center = SkyCoord(float(primary[ra_key]) * u.deg, float(primary[dec_key]) * u.deg, frame=frame, **kwargs).icrs
            result = dict(record)
            result.update(ra_deg=float(center.ra.deg) % 360, dec_deg=float(center.dec.deg),
                          position_role="pointing", position_method="fits_target_header", coordinate_frame="ICRS")
            return result
    return None

def emit(value):
    print(json.dumps(value, separators=(",", ":"), allow_nan=False), flush=True)

def process(records):
    points = []
    for record in records:
        try:
            point = image_position(record)
            if point is not None:
                if not math.isfinite(point["ra_deg"]) or not math.isfinite(point["dec_deg"]):
                    raise ValueError("non-finite WCS coordinate")
                points.append(point)
        except Exception as error:
            emit({"file_id": record["file_id"], "hdu_index": record["hdu_index"], "error": str(error)})
    if not points and records:
        try:
            point = pointing_position(records[0])
            if point is not None:
                points.append(point)
        except Exception as error:
            emit({"file_id": records[0]["file_id"], "error": str(error)})
    for point in points:
        emit(point)
    if not points and records:
        emit({"file_id": records[0]["file_id"], "error": "no usable science WCS or target coordinates"})

if len(sys.argv) > 1 and sys.argv[1] == "--contains":
    for line in sys.stdin:
        record = json.loads(line)
        try:
            header, _ = header_for(record)
            pixel = WCS(header).celestial.world_to_pixel(SkyCoord(record["query_ra"] * u.deg, record["query_dec"] * u.deg, frame="icrs"))
            emit({"id": record["id"], "contains": bool(-0.5 <= pixel[0] <= int(header["NAXIS1"]) - 0.5 and -0.5 <= pixel[1] <= int(header["NAXIS2"]) - 0.5)})
        except Exception:
            emit({"id": record["id"], "contains": False})
else:
    records = []
    for line in sys.stdin:
        record = json.loads(line)
        if records and record["file_id"] != records[0]["file_id"]:
            process(records)
            records = []
        records.append(record)
    process(records)
