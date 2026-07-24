# Patent Evidence Map

This document records engineering evidence for counsel. It is not a novelty
opinion, freedom-to-operate analysis, or substitute for a prior-art search.

## Implemented technical chain

| Technical feature | Prototype evidence | Technical effect |
| --- | --- | --- |
| Sparse direction-radius joint cells | `astro-atlas-joint-v1`, 81,917 occupied records | Avoids materializing empty angular-radial products |
| Hierarchical direction axis | NESTED NSIDE 8-512 | Restricts angular drill-down to descendants of one parent pixel |
| Hierarchical radial axis | 1-32 binary intervals | Restricts distance drill-down without forcing angular subdivision |
| Independent refinement scoring | `/api/atlases/:id/refinement` | Compares normalized child variation against encoded child cost |
| Conservation check | Angular and radial child sums tested against the parent | Prevents duplicate or missing counts during replacement |
| Statistical-to-object representation | Joint-cell and DESI point modes | Transfers summaries before full object records |
| Shared 2D/3D identity | Survey, NSIDE, pixel, radial level, radial bin | Reuses index identity across survey shells and physical volume |
| Content-addressed scan lineage | `scan-run.json`, SHA-256 inputs/outputs, `/api/lineage/:id` | Makes derived summaries reproducible without retaining source files in the runtime |
| Cell-to-object reconciliation | `/api/atlases/:id/objects` checks the sparse-cell count | Detects divergence between aggregate and object representations before returning drill results |

## Measured evidence

The real DESI-COSMOS benchmark preserves all 161,518 objects while the overview
reads eight sparse cells. A local joint drill examines 208 cells and returns 32
records instead of emitting 13,410 point records. The encoded response estimate
falls from 375,480 to 640 bytes for that scenario.

The deployed object endpoint independently reconciled 13,410 indexed objects
for NSIDE 32 pixel 6814 and radial bin 1. Its first lazy index construction took
839.5 ms; the repeated query reported 0.139 ms with the same exact count. A
repeated real FITS scan also reproduced the point artifact SHA-256 exactly.

These values support reduced examined units, transfer volume, and graphics
buffer input. They do not yet support claims about persistent database I/O,
cold-cache latency, survey completeness, or effective physical volume.

## Claim-drafting boundary

HEALPix, radial bins, redshift filtering, and 3D volume rendering should not be
presented as isolated inventive concepts. The stronger candidate combination is:

1. sparse canonical joint cells with two independently refinable axes;
2. radial uncertainty mass allocated across intervals;
3. an error-reduction versus processing-cost decision between refinement axes;
4. revisioned, conserving parent-child replacement;
5. reuse of the same cell identity and cached content across two-dimensional,
   semantic multi-survey, and physical-volume views.

Before filing, reproduce the benchmark against persistent storage, implement
request generations and parent revisions, add one real redshift-PDF sample and
one real survey depth/completeness map, and complete CNIPA/WIPO/paper prior-art
searches with patent counsel.
