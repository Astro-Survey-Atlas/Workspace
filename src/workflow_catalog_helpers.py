import math
import numpy as np

ALIASES = {
    "ra": ["rightascension", "rightascensiondeg", "ra", "radeg", "raj2000", "alphaj2000", "alpha", "raicrs", "raicrsdeg", "ra2000"],
    "dec": ["declination", "declinationdeg", "dec", "decdeg", "dej2000", "deltaj2000", "delta", "decicrs", "decicrsdeg", "dec2000"],
    "id": ["objectid", "sourceid", "targetid", "objid", "id", "number", "catalogid"],
    "magnitude": ["magvis", "magauto", "magnitude", "mag", "magr", "rmag", "photgmeanmag"],
    "classLabel": ["extendedflag", "classification", "class", "objtype", "type"],
}

OPTIONAL_ALIASES = {
    "tileIndex": ["tileindex", "tileid", "tile_id"],
    "brickname": ["brickname"],
    "fitsPath": ["fitspath", "imagepath", "catalogpath"],
    "imageG": ["imagegpath", "gimagepath"],
    "imageR": ["imagerpath", "rimagepath"],
    "imageI": ["imageipath", "iimagepath"],
    "imageZ": ["imagezpath", "zimagepath"],
}


def normalized(value):
    return "".join(character.lower() for character in value if character.isalnum())


def resolve_columns(names, requested):
    exact = set(names)
    by_normalized = {}
    for name in names:
        by_normalized.setdefault(normalized(name), []).append(name)

    resolved = {}
    for field, aliases in ALIASES.items():
        explicit = requested.get(field)
        if explicit:
            if explicit not in exact:
                raise ValueError("configured catalog column was not found")
            resolved[field] = explicit
            continue
        for alias in aliases:
            matches = by_normalized.get(alias, [])
            if len(matches) == 1:
                resolved[field] = matches[0]
                break
            if len(matches) > 1:
                raise ValueError("catalog columns are ambiguous")

    for field in ["tileIndex", "brickname", "fitsPath", "imageG", "imageR", "imageI", "imageZ"]:
        explicit = requested.get(field)
        if explicit:
            if explicit not in exact:
                raise ValueError("configured catalog column was not found")
            resolved[field] = explicit
            continue
        for alias in OPTIONAL_ALIASES.get(field, []):
            matches = by_normalized.get(alias, [])
            if len(matches) == 1:
                resolved[field] = matches[0]
                break
            if len(matches) > 1:
                raise ValueError("catalog columns are ambiguous")

    if "ra" not in resolved or "dec" not in resolved:
        raise ValueError("catalog requires recognizable RA and Dec columns or an explicit column map")
    return resolved


def json_value(value):
    if value is None or np.ma.is_masked(value):
        return None
    if isinstance(value, np.ndarray):
        return [json_value(item) for item in value.tolist()]
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").strip()
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, (float, np.floating)) and not math.isfinite(float(value)):
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)

