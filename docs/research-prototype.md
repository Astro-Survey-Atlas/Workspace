# Sparse Angular-Radial Drill-down Prototype

## Research question

Can a sparse, independently refinable NESTED HEALPix-by-radius index reduce the
data examined and transferred during multi-survey visual drill-down while
preserving exact catalog counts?

The prototype separates two visual semantics:

- survey-shell radii are presentation offsets for comparing modalities;
- physical volume radii are Planck18 comoving distances inferred from redshift.

## Data and method

The generated `cosmos-multisurvey-v1` artifact contains real catalog membership:

| Survey | Objects | Radial coordinate |
| --- | ---: | --- |
| DESI-COSMOS layer catalog | 43,658 | none in the layer artifact |
| HSC PDR3 | 704,634 | unavailable |
| HST ACS | 704,645 | unavailable |
| GALEX | 183,480 | unavailable |
| DESI-COSMOS physical volume | 161,518 | Planck18 comoving distance |

Angular levels are NSIDE 8 through 512. Radial levels contain 1, 2, 4, 8,
16, or 32 equal-comoving-distance intervals over 0-6000 Mpc. Only occupied
joint cells are stored: 81,917 records (1.64 MB) across all 42 level pairs.

The benchmark compares an in-memory scan of every DESI point with indexed
joint-cell lookup. Timings are medians of 12 point scans and 60 indexed
queries in the same Node 22 container on `eva7028`. Encoded sizes use the
published binary record sizes: 28 bytes per point and 20 bytes per joint cell.

## Initial result

| Scenario | Exact objects | Point records examined | Joint cells examined | Cells returned | Point bytes | Cell bytes | Median point scan | Median index lookup |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Overview | 161,518 | 161,518 | 8 | 8 | 4,522,504 | 160 | 0.800 ms | 0.017 ms |
| Angular drill | 13,410 | 161,518 | 28 | 4 | 375,480 | 80 | 3.477 ms | 0.011 ms |
| Joint drill | 13,410 | 161,518 | 208 | 32 | 375,480 | 640 | 3.386 ms | 0.042 ms |

All three scenarios conserve exact object counts. The generated machine-readable
report is stored beside the atlas as `benchmark.json`.

## Reproducibility and object drill validation

The v0.5 deployment records the real DESI volume as scan run
`desi-cosmos-v2-scan-265ce1d0440f35d8`. Reprocessing the 1,451,643,840-byte
FITS source reproduced the deployed `points.bin` SHA-256 exactly
(`f5c36541...65091`). The runtime stores 7.0 MB of catalog metadata, point and
cell indexes, and provenance in an NFS PVC; it does not mount the source OSS or
retain the FITS file.

An HTTP object-drill acceptance query for NSIDE 32, pixel 6814, eight radial
bins, and radial bin 1 returned an exact total of 13,410 objects, equal to the
joint-cell count. Building the level-specific in-memory object index took
839.5 ms on its first request. A repeated request reused that index and reported
0.139 ms query time. These are single acceptance observations, not latency
distributions.

## Interpretation and limitations

This is a warm, in-memory catalog-occupancy experiment, not yet a database or
object-store cold-cache benchmark. It demonstrates deterministic pruning,
payload reduction, independent refinement, and parent-child conservation.
It does not yet demonstrate scientific completeness correction.

HSC, HST, and GALEX currently have angular membership only. They are not placed
at inferred physical distances. No limiting-magnitude map, redshift PDF,
selection function, or injection-recovery completeness curve is synthesized.
Physical-density and effective-volume claims require those inputs.

## Paper path

The next experiment should compare five methods on identical view trajectories:
point scan, two-dimensional HEALPix plus radial filtering, fixed joint grid,
synchronous 3D subdivision, and independent error-cost refinement. Report cold
and warm P50/P95 latency, database pages, response bytes, GPU upload bytes,
count error, boundary continuity, and time to stable visual error.
