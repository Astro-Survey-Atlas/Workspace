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
indexes. Assets may show a small anonymous lookup preview; a valid API Key
authorizes the full scoped, paginated lookup. Workspace public lookup always
uses its server-side Key and never falls back to the anonymous preview.

An Assets lookup without a snapshot selector reads the current state and
freezes its result. Continuation cursors stay on that snapshot; preview
revalidation names the same snapshot. `page.hasMore=false` means no further
page remains in that cursor chain. `querySnapshot.queryExhausted` tracks whether
the underlying bounded query/search completed and can remain false under query
limits or gaps. `truncated` reports source/query limits or omitted evidence and
can remain true after page exhaustion. `inventoryComplete` independently
describes completeness of the declared source inventory. A fully drained export
may therefore have `page.hasMore=false`, `querySnapshot.queryExhausted=false`,
`inventoryComplete=false` and `truncated=true`. Workspace sends only public
layer IDs, HEALPix order/cells, public unit IDs and cursor/snapshot selectors.
CSST paths, IDs, hashes, scan records, private MOCs and parent directories
never enter Assets requests.

Raw public lookup, footprint, native-index and snapshot responses exist only in
the serving request and browser memory. They are not written to Workspace
storage, persistent caches, artifacts, production recipes or log bodies. A
browser may export its temporary JSON/CSV source manifest. Of Assets response
metadata, the only persistence exception is a user-confirmed download task's
minimal selected-file inventory (source identity, URI, size, checksum and
relative destination) and progress. That inventory freezes the confirmed file
set if a later Assets query finds more files; it contains no raw response or
shared index. The full source files fetched by Workspace are task outputs at
the chosen Workspace destination. Assets owns the public snapshot and never
downloads scientific data. Workspace requires its valid API Key for native
lookup; without it, public geometry and private directory lookup remain
available while public native lookup is unavailable.

The phase-two stateless preview and confirmed-task request contract is defined
in [Download Plan Workflow](download-plan-workflow.md).

The first MVP uses Euclid, DESI, Legacy Surveys and HST. Selected products are
unioned within each survey only at an order supported by every selected product
in that survey, then survey unions are intersected with local CSST at the
highest shared real order. A lower-order selected product constrains the common
order; Workspace never drops it or expands its cells to a finer order. A selected
empty survey must produce empty overlap rather than disappear. Component clicks
query the entire bounded region (4,096 cells / 100 square degrees); larger
regions require a smaller selection. Continuation/export drains the same Assets
snapshot, updates the browser list, and preserves native IDs, all URIs, modality,
footprint, order and precision.

CSST coverage and file mapping belong to Workspace. Private reverse lookup
reads only owned, committed scan layers and returns deduplicated immediate
parent directories of matching indexed files. It does not read science data,
list every file, or replace an unknown parent with the scan root. Public units
and private directories remain separate in display and manifest exports.

Directory lookup uses Elasticsearch composite aggregation by candidate layer,
file identity and native order across the complete selected region. Each group
retains one real matching native cell and the least precise evidence across its
edges; small locator-only file joins resolve the immediate parent. Parent
directories are merged as pages arrive. Repeated coverage edges and files do
not consume the directory budget, which uses the configured metadata limit
(200,000 by default). Missing committed locators, incomplete scan pointers,
partial searches or an omitted parent set `directoriesTruncated`.

`matchingCellsTruncated` on a directory separately says that its listed native
cells are representative matches, not the full per-file footprint. At most
4,096 representative cells are retained per parent. Sampling cell evidence does
not mean a parent was omitted, and an O4 query never relabels O10 scan evidence.
Both JSON and CSV retain this distinction. The existing full-edge file lookup
keeps its own file/cell limits for callers that need individual mappings.

The browser sends only the public selectors returned on the first page for
continuation. The server parses those concrete identities and delegates region,
revision, expiry and cursor validation to Assets, without re-fetching the DR9
overview or querying private directories. Continuation source records are
identity echoes with empty `pixels`, not new coverage evidence. The browser
keeps the original private parents while merging public pages. HTTP 429 from
Assets becomes `publicRetryAfterSeconds` in the temporary Workspace response;
export waits for that delay and retries the same public page once. The Key's
configured request limit remains enforced.

File evidence retains `matchingCoverageTruncated` and file warnings separately
from response pagination. A completed file list can still have incomplete
coverage matches for an individual file; Workspace displays that limitation
and preserves it in the returned evidence even when the response-level
`truncated` flag is false.

User assets constrain the region and overlap calculation; they are never
converted into public download items.

## Dev acceptance: 2026-10-02 (Assets 311 / Workspace 62)

The desktop acceptance images were Assets `0.1.0-20261002-022932-multipart-manifest` and
Workspace `0.10.38-dev-20261002-022932-native-version`. Both deployments are
Ready, with zero restarts. Workspace retains its 1 CPU / 1 GiB limit.
Legacy's published color-imaging modality was reviewed and corrected to
`imaging`; Workspace installed the resulting Legacy package 3.2.0 through its
resource-package API, preserving other installed packages and active selections.
All 105 published native MOC hashes remained unchanged by this metadata release.

The full desktop component-click, JSON and CSV checks passed on these images.
The complete O4 seven-cell component returned 9,056 public native records
(Euclid 744, DESI 131, Legacy 5,682 and HST 2,499) and 3,893 immediate private
parents, with `directoriesTruncated=false`. Every native identity, URI,
modality, original HST `s_region`, actual order and precision was identical
between the final display and both exports. The CSV export made zero additional
snapshot-page requests after JSON completed. Two real Key rate-limit waits
resumed the same snapshot; ordinary clicks and direct MAST requests were zero.
There were no browser page errors. The final active-version check used 93 cursor
requests, including the recovered quota waits.

The final check used Assets' active native group
`7934212d371634751fc1119c3a9a5ccccb10e8061dce5d930988c50bf8b7d7b6`, generation 1.
Assets completed all 640 archive dependencies, group restore/reverification,
UI gap review, CAS activation and site HTTP verification through its management
workflow. Its real DR10 acquire/build retained the active group and both original
SQLite hashes. JSON preserves `nativeUnitIndexRevision`; Workspace CSV
retains it in the `manifest-state` details. Final pagination does not erase
HST's eighteen unresolved-frame exclusions or claim complete survey inventory.
Public responses, private exports and preferences were kept in memory; no real
private response, directory, region, scan identity or screenshot was saved.
Assets alone owns the public authority, source/index files and query snapshots.
The summary evidence is `/tmp/assets-managed-active-workspace-desktop.log`.

The complete seven-cell SSE check returned a meaningful Workspace batch in
4.692 s and completed in 33.495 s, with 52 batches and all 3,893 parents.
Assets' corresponding public check took 4.437 s / 20.189 s. Initial mixed
geometry took 12.376 s and its reuse 0.560 s. These timings precede full
paginated export; the configured Key quota still applies. The Workspace
container remains 1 CPU / 1 GiB. Only summary metrics were written to
`/tmp/assets-managed-active-stream-perf.log`.

Assets subsequently deployed revision 312 with image
`0.1.0-20261002-054741-snapshot-batches` to acknowledge uploaded control
snapshots in bounded batches. Its native-management, publication-task and
API-management mirrors are synced; isolated native-control restoration matches
local state. The active native group, generation 1, public release and reverse
runtime remain verified. Workspace remains on revision 62. This follow-up used
health/status and control-state checks, without repeating the complete desktop
or private-data scenario.

## Earlier Dev acceptance: 2026-10-01 (Assets 305 / Workspace 58)

Workspace image `0.10.38-dev-20261001-191625-directory-aggregation` is Ready,
with zero restarts and the same 1 CPU / 1 GiB resource limits. Assets image
`0.1.0-20261001-185000-mvp-manifest` remains Ready. No geometry package was
installed/activated and no MOC or public bundle was published; the public
bundle remains 603 files with SHA-256
`0e23aca242d542d3b7ae8d96a846d2eed1ef1eabcb4f573fadeaa493c3905d6e`.

The complete mixed component was O4, seven cells and about 94 deg². API lookup
returned 3,893 immediate parent directory records, with native O10 and
`directoriesTruncated=false`; its fourteen selected public product layers
drained 92 public manifest pages containing 9,056 native records
(Euclid 744, DESI 131, Legacy 5,682, HST 2,499). No region
cells were dropped. Directory-only lookup returned the identical parents with
no Assets result, and a no-Key client made zero outbound public queries.

Desktop verification waited for actual private coverage to load, selected the
four public surveys and the CSST asset card, and clicked the entire component.
Related Warehouse layers collapse into the asset card, so the browser selected
one private source rather than the API's duplicate layer identity. JSON and CSV
exports preserved the same 9,056 public records and 3,893 parents as the final
display, with identical native IDs, every URI, HST `s_region`, precision, actual
orders and directory sampling flags. The Key rate limit recovered twice;
continuation retained one snapshot and never repeated private selectors.
Ordinary clicks caused no native lookup; page errors and direct MAST requests
were zero. Private exports and preferences were intercepted in memory;
verification did not save real private paths, cells or source/scan identities.

Assets independently passed desktop acceptance for the same full public
seven-cell component with twenty selected product layers: 22,772 native
records in authorized JSON/CSV, preserving every URI, footprint and precision
field and matching the final displayed count. The different record total
reflects the different layer selection. All eleven survey combinations,
anonymous-preview export and API-Key unlock passed, with zero page errors or
direct MAST requests. Public native indexes and snapshots remain in Assets.

The public Abell 2390 O8 replay still drained two pages and returned 74 native
records / 104 URI entries: Euclid ERO 5, DESI DR1 1, Legacy DR10 11 and HST 57.
It returned no private directories. All pages were exhausted in both examples,
while HST's eighteen unresolved-frame rows keep public
`queryExhausted=false`, `truncated=true` and `inventoryComplete=false`.

The old private query read 931,000 edges over 931 pages, took 98.7 seconds and
hit the 50,000-file limit. The aggregate directory probe read 25 file-group
pages in 33.9 seconds and returned the complete parent list; no raw coverage
hits were transferred. The mixed reverse API took about 50.0 seconds after
geometry selection. Build/types and Helm lint/template passed; the Workspace
suite had 306 tests, 304 passed, 2 skipped and no failures. Original worktree
changes and data remain uncommitted and preserved.

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

## Follow-up: local HST index and DR10 scope (2026-10-01)

Assets revision 298 serves HST observation lookup from a local SQLite v4 index
built from a SHA-locked MAST CAOM snapshot. Ordinary cell lookup and overlap
reverse lookup do not query MAST at request time. MAST supplies the public
observation metadata snapshot and remains the user-facing source link for the
current product list and access policy. The 45-second HST timeout recorded
above was revision-294 behavior.

The v4 snapshot has 1,201,094 public image rows. Its index contains 916,116
observations and 18 rows with unresolved coordinate-frame labels (`GSC1` or
`OTHER`); those rows remain excluded and HST inventory remains incomplete. The
preceding v3 index excluded 103 rows, including long or malformed compound
footprints that the updated bounded parser now handles. Assets Dev's direct
order-8 C04 HST request returned HTTP 200 with 158 observations,
`queryExhausted=true`, `truncated=true` and 18 excluded rows. This confirms
local lookup and drained results, not complete HST inventory.

The historical revision-296 Workspace result for public Abell 2390 C04 was 74
unique public units across five pages: DESI 1, Euclid 5, Legacy DR10 11 and HST
57, with no duplicates and `hasMore=false`. That run used the v3 parser, so its
103-row geometry gap was reduced to 18 unresolved coordinate-frame rows by v4.
The result count also differs from revision 294 because the source changed
from a live MAST query to a fixed, hash-locked snapshot.

Legacy north-side candidates must keep the **DR9 North** release identity.
Assets has no verified DR10 North roster or product tree; its DR10 South brick
roster is already indexed in full. Workspace's DR9 supplement requests the two
Assets O4 overview blocks through the Key-protected
`POST /api/v1/access/coverage-block` route. It uses the response only in
request memory for overlap calculation and does not persist the returned
cells. During a mixed lookup, Assets receives public layer IDs, the selected
component's order/cells as the requested region, and pagination selectors. It
does not receive CSST asset/layer identity, file paths, scan identity or
file-level metadata. The overview is estimated and limits shared overlap to
O4; it does not imply brick-file existence. Without an Assets Key, the DR9
supplement is unavailable and no anonymous block fallback is allowed.

Workspace revision 53 was rechecked through its server-side Assets API Key
against Assets revision 298, scoped to the four public surveys and the current
Workspace CSST survey set. The service returned three O8 cells in two
components. Both components lie entirely north of Dec 32.375 degrees, the
published DR10 South boundary. Each returned zero DR10 South bricks, which is
the expected release-scope result rather than a missing South index. The
official DR10 files page has no North brick roster or North Coadd/Tractor tree;
the all-sky geometry table cannot establish DR10 membership. North Legacy
imaging and Tractor links must use the distinct DR9 North identity. Assets has
DR9 North/South candidate matchers, but their declared available order is O4
and precision is estimated; selecting them limits shared overlap to O4 and
must not relabel those candidates as DR10.

The HST matches in both components came from the local SQLite observation
index; this Workspace-to-Assets request did not time out or query MAST. It
returned 5 and 8 HST observations, respectively. Each component fit on one
page (`hasMore=false`), while the aggregate response remained
`queryExhausted=false`, `truncated=true` and `precision=truncated` because the
local HST inventory still excludes 18 rows with unresolved coordinate frames.
Page exhaustion therefore does not imply a complete source result.

JSON and CSV were compared from the same in-memory response for both
components: public unit rows matched 30 and 45 records, and Workspace directory
rows matched 54 and 63 deduplicated immediate parents. Directory values,
private asset identities, full CSST coverage maps and scan metadata remain in
Workspace. The selected component order/cells are sent as the lookup region;
no per-file path or CSST source identity crosses into Assets. No CSST scan or
science-file read was performed.

## Revalidation after Assets revision 300 (2026-10-01)

Assets revision 300 (`0.1.0-20261001-152556-dr9-time-fix`) and Workspace
revision 54 (`0.10.38-dev-20261001-145752-dr9-keyed`) are both Ready. The
Assets health endpoint still reports the unchanged public bundle SHA-256
`0e23aca242d542d3b7ae8d96a846d2eed1ef1eabcb4f573fadeaa493c3905d6e` and 603
files.

The revision-300 Key-protected DR9 overview response supplies `generatedAt`.
Workspace loads two O4 overview layers: DR9 Coadded imaging with 1,707 cells
and Tractor catalog with 1,716 cells. A public-only overlap selecting Euclid
ERO, DESI DR1, Legacy DR9 and HST archive coverage resolves to O4, with 7 cells
in 3 components. This lower order reflects the DR9 overview input; it does not
assert O4 brick-file existence.

For public component C01, the first mixed reverse-lookup page returned 31 DESI
DR1 Tile units and 69 HST archive observations. The request completed without
a MAST timeout; HST observations came from the local snapshot. The page held
100 of 4,951 spatial units and advertised more pages. A DR9 Coadded imaging
lookup for the same component returned 100 estimated brick candidates with
URI fields, with 3,972 more items available through pagination. The candidates
remain unverified for individual file existence. This confirms the DR9 native
matcher is reachable through Workspace, but this broad O4 component has not
been fully paged or checked for JSON/CSV parity yet.

On the documented O8 C04 cells `[202250,202272]`, a public-only request with
Legacy DR10 selected returned 11 `DR10 color imaging` brick candidates with
URI fields, `hasMore=false` and `truncated=false`. Thus a zero result in the
separate component north of Dec 32.375 degrees is the expected DR10 South
scope result; it is not evidence that the DR10 South index is missing.

These checks set `includeWorkspace=false`; no CSST coverage, paths or scan
identity were requested or read. The direct Assets HST endpoint returned 158
observations from snapshot SHA-256
`d09e1a1d9863b3328f227040a5fb44043519402e8903747cf0dd6ab436d04ee8`, with 18
unsupported coordinate-frame rows still excluded. Its query completed with no
request-time MAST call; `truncated=true` denotes the unresolved inventory gap,
not a timeout.

Next acceptance should select a smaller public component and drain every page
from the same Assets query snapshot, then compare displayed units against both
temporary manifest formats. Keep DR10 South and DR9 North identities separate;
do not label North candidates as DR10.

## O8 Mixed Component Revalidation (2026-10-01)

Workspace revision 54 and Assets revision 300 were checked with the four public
survey groups and the existing CSST layer. Their O8 intersection contained 3
cells in 2 components. The smaller component had one cell. Its Assets page
completed without a continuation cursor and returned 30 public spatial units:
DESI DR1 1, Euclid Q1 24 and HST 5. It returned no Legacy DR10 South brick,
while coverage evidence remained available for all four public surveys. The
result includes 78 public URI entries. The lack of a South brick is consistent
with the selected region's location north of the DR10 South release boundary;
it does not establish DR10 North imaging.

Workspace returned 54 deduplicated immediate file parents and did not mark the
directory response truncated. JSON and CSV manifest serializers matched the
public spatial-unit rows and URI payloads, and matched every private directory
row. There was no HST request-time MAST call or timeout. The result still has
`queryExhausted=false`, `truncated=true` and `precision=truncated` because the
local HST snapshot excludes 18 observations with unresolved `GSC1`/`OTHER`
coordinate frames. Page exhaustion does not claim inventory completeness.

A broader O4 mixed component with 7 cells reached the Assets request deadline
and Workspace marked its local parent-directory query incomplete at the
configured metadata/query limit. Its HTTP response had no Assets result; this
must not be presented as zero public matches. Narrow large O4 components before
reverse lookup or improve the query cost and continuation path.

The pure-public Abell 2390 C04 flow was also drained through Workspace: 74
spatial-unit identities across DESI DR1 (1), Euclid ERO (5), Legacy DR10 (11)
and HST (57), with 104 URI entries. JSON and CSV retained the same unit and URI
payloads across both pages. The remaining HST incomplete flag is due to the 18
excluded observations, not a MAST timeout.

No science files were read, no private paths or identifiers were copied into
this document, and no source data or Workspace state was changed during these
read-only checks.
