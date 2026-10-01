# Public Coverage Boundary

## Purpose

Astro Survey Atlas Assets and Workspace are independent applications. Their
integration must preserve that independence while making public sky coverage
useful in both applications.

## Ownership

Assets is the authority for published public-survey statistics and coverage
geometry. A package may contain validated MOC files and display footprints;
Workspace installs and verifies those files and can render them without a
runtime dependency on Assets.

Workspace is the authority for user assets, scans, user MOCs, and local spatial
queries. A user may discover that a public survey covers a region without being
able to obtain the corresponding files. That distinction is intentional:
coverage means that the official survey recognizes the region, not that a
download is guaranteed.

Assets may additionally expose a bounded, authenticated API for reverse lookup
of public data units. This API is an optional data-access capability, not the
source of Workspace's ordinary public sky map.

## Package-first geometry

Resource Package v3 is the public geometry boundary. It contains verified
metadata, provenance, display footprints, and native MOC files. Workspace may
derive coarser display resolutions from a MOC, but must not claim precision
finer than the supplied geometry.

Packages may also carry manifest-declared `healpix/order4.json` and
`healpix/order8.json` cell-list sidecars for clients that need a direct list of
published cells. Workspace verifies their package/layer identities, declared
order, ICRS/NESTED metadata, file hashes, cell ordering and union. These are
optional convenience exports; native MOCs remain the geometry source used by
Workspace drawing and overlap.

The package layer identity remains explicit:

```text
survey + release/DR + product + sourceId/layerId
```

A survey-level identifier such as `public:desi` is not a downloadable source.
Missing source identity is an invalid download-plan item; it is never resolved
by guessing a survey-wide URL.

## Display and overlap

Both applications use ICRS coordinates and NESTED HEALPix. Their display
projection, cell geometry, ordering, opacity, inset, and overlap layering
should be kept visually equivalent where the same package geometry is shown.
Workspace may combine package MOCs with local user coverage, but user layers
remain separately identified and may use finer local MOC orders.

Public geometry and geometric overlap remain available when no reverse index or
download endpoint is available.

## Availability states

Assets reports the state of public knowledge, not an unconditional download
promise. A product can have a verified MOC while its files are unavailable,
its entrypoint is only informational, or its tile index is incomplete.
Workspace should preserve these distinctions in the UI and plan review:

- geometry available: display and overlap are allowed;
- entrypoint only: show the source and explain that retrieval is not assured;
- candidate/incomplete: show candidates but require confirmation;
- tile-resolved: a concrete public data unit is available for a plan;
- unavailable: do not silently create a download item.

## Separation from private reverse indexes

Workspace must not copy or maintain any Assets native-unit index, public cell
mapping, reverse-response cache or snapshot. Resource packages contain public
MOCs, previews and layer metadata only; geometry sidecars are not native-unit
indexes.
When a user asks for public data units, Workspace's server may call an
authenticated Assets endpoint for the requested region and explicit
public layer identity. Only public layer IDs, order/cells and page/snapshot
selectors cross this boundary. CSST paths, IDs, hashes, scan records and private
MOCs never enter Assets requests.

Public responses exist only in the server request and browser memory. They
cannot be written to Workspace storage, persistent caches, artifacts, production
recipes or log bodies. A browser may export its temporary JSON/CSV manifest.
Assets owns the immutable query snapshot, revision, expiry and pagination.
Without a valid Workspace Assets API Key, public native lookup is unavailable;
there is no anonymous retry, directory crawl or download-production fallback.
Public geometry and private directory lookup still work.

The first MVP uses Euclid, DESI, Legacy Surveys and HST. Selected products are
unioned within each survey, then survey unions are intersected with local CSST
at the highest shared real order. A selected empty survey must produce empty
overlap rather than disappear. Component clicks query the entire bounded region
(4,096 cells / 100 square degrees); larger regions require a smaller selection.
Continuation/export drains the same Assets snapshot, updates the browser list,
and preserves native IDs, all URIs, modality, footprint, order and precision.

CSST coverage and file mapping belong to Workspace. Private reverse lookup
reads only owned, committed scan layers and returns deduplicated immediate
parent directories of matching indexed files. It does not read science data,
list every file, or replace an unknown parent with the scan root. Public units
and private directories remain separate in display and manifest exports.

File evidence retains `matchingCoverageTruncated` and file warnings separately
from response pagination. A completed file list can still have incomplete
coverage matches for an individual file; Workspace displays that limitation
and preserves it in the returned evidence even when the response-level
`truncated` flag is false.

User assets constrain the region and overlap calculation; they are never
converted into public download items.

## Dev acceptance: 2026-09-30

Workspace revision 53 uses image
`0.10.38-dev-20260930-232630-lookup-status` at
`http://astro.workspace.dev.72602.space:32080/`; Assets is revision 294 at
`http://10.15.51.75:32083/atlas/`. Both application deployments are Ready and
the existing public bundle, private scans and package selections are retained.

The public Abell 2390 C04 component returned 79 native units in the latest
desktop lookup, with all four surveys represented. JSON and CSV exports drained
one Assets snapshot and matched the displayed units and every URI. The earlier
revision-52 result was 78; live HST metadata can change the measured count.

The existing CSST layer intersects the four public survey unions in three
order-8 cells, split into two components. Desktop inspection of the one-cell
component returned 54 deduplicated immediate file parents at native order 10,
with estimated precision. Public units and private directories matched both
JSON and CSV exports. Every public survey retained coverage evidence and an
official entrypoint, even when no native unit was returned.

This is not an acceptance of four native-survey hits in the private overlap.
The current Legacy DR10 South inventory returned no brick in these components.
HST metadata returned seven observations in one API probe but reached the
45-second deadline in the final desktop run, which exported 25 DESI/Euclid
units with `truncated=true` and `queryExhausted=false`. Workspace displays
surveys without returned native units after paging, and preserves empty-result
and source-failure notes and clickable official entrypoints. Source inventory
gaps are not filled with inferred IDs or science-file requests.

The final revision-53 server acceptance read five pages of 25 items for C04,
returning the same 79 public units. A later five-way request returned 32 public
units, including seven HST observations, and the same 54 private directories;
all four surveys retained coverage evidence and official entrypoints. The
Legacy native inventory gap remained. The no-Key client made zero outbound
fetches and an invalid Key was rejected without a fallback. A private-only
request returned 47 parents at order 10 and no Assets response. Existing
DESI + Legacy + CSST overlap also retained its 5,004 order-8 cells.

At 1600 by 1000, the canvas had 165 sampled color bins and changed pixels when
dragged. There were no page errors, document overflow or direct browser
Assets/MAST requests. Ordinary clicks made zero reverse-lookup requests.
Screenshots and browser exports remain temporary local acceptance artifacts;
private directory values and scan identities are not recorded in this document.

Selected private geometry requests took about 22 seconds at explicit order 8
and about 45 seconds when choosing the common order. Archive lookup can add its
bounded metadata-query latency. Keep this performance limit visible in handoff;
do not treat missing native units as a pagination bug or extend inventory
without verifying the public source evidence.
