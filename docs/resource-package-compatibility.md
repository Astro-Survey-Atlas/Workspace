# Current Assets Resource Package v3 compatibility

Verified 2026-09-20 against release `reviewed-mu9992i3-7e599e9b`.
Dev: Helm `asa`, namespace `asa-workspace`, revision 30,
image `0.10.38-dev-20260920-package-compat`.

The catalog allows empty `sources`. Optional descriptive lists `wavelengths`,
`productTypes`, `coverageAuthorities` normalize to empty arrays. Invalid present
values still fail validation. Identity/version/size/hash checks are unchanged.

Reviewed package previews declare ICRS/NESTED and a per-layer NSIDE. The package
adapter verifies each layerId/surveyId/releaseId against the validated native MOC
manifest, rejects mismatches, RING ordering and inconsistent NSIDE, and preserves
pixels without refinement. It fills display labels from product names, records
local receipt time, and leaves missing source URLs absent. The archive bytes
remain unchanged. Native FITS MOC files remain the scientific geometry interface.

`GET /api/resource-packages/config` and runtime catalog status report `stale` and
`lastSyncError` separately from `available`. A failed sync preserves the current
verified snapshot and active selections, but does not claim it is current. No
older snapshot or package version is selected as a repair. Success clears the
failure state and advances the snapshot.

Validation: build and 261 unit tests passed (2 optional tests skipped); the
live catalog contract downloads, verifies, installs and activates each current
package in an isolated temporary directory. Production installation then passed
for DESI 3.2.0, Euclid 3.6.0 and Gaia 3.1.0, exposing 7 native MOCs. Production
active selections were preserved. Run the live contract with:

```sh
ASTRO_RESOURCE_CATALOG_URL=http://<assets>/api/v1/resource-packages/catalog.json \
  npx tsx --test test/resource-catalog-contract.test.ts
```

Existing uncommitted Warehouse scan, RBAC, connector and viewer work was retained.

## Optional HEALPix cell lists (2026-09-24)

Resource Package v3 may declare `healpix/order4.json` and/or
`healpix/order8.json` in `resource-package.json.files`. Each declared file is
checked against its manifest size and SHA-256 before its JSON is accepted.
Undeclared HEALPix files and all other unlisted ZIP members remain invalid.

The sidecar uses `schemaVersion: 1`, the package `surveyId`, `packageId`, and
`packageVersion`, a non-empty package/coverage `revision`, `coordinateFrame:
"ICRS"`, `ordering: "NESTED"`, and the exact order encoded in its path. Its
`layers` entries identify manifest layers by `layerId`, `surveyId`,
`releaseId`, `productId`, `sourceId` when present, and `product`; each entry
contains sorted, unique, in-range `cells`, `precision` (`exact`, `estimated`,
or `unknown`) and `completeness` (`complete`, `incomplete`, or `unknown`).
Each manifest layer must appear exactly once in `layers` or
`surveyUnion.omittedLayers`. A listed layer must have manifest `maxOrder` at
least as high as the sidecar order; an omitted layer must declare a lower
`maxOrder` and a non-empty reason. This prevents an order-4 list from being
presented as order 8 and prevents a sufficiently precise layer from silently
disappearing from the union.
`surveyUnion.cells` must equal the sorted union of those layer cell lists.
Union precision and completeness must match the listed layers and omissions;
`unknown` remains `unknown`, and omitted or incomplete coverage cannot be
reported as complete.

Workspace validates these optional lists during installation but does not load
them into the sky map or overlap path. Current validation checks the sidecar
cells' order, range, sorting, uniqueness, identity and union consistency against
the package manifest. It does not independently re-project the native FITS MOCs
to compare cell-for-cell; native FITS MOCs remain authoritative for spatial
queries. Sidecars are metadata projections, not scientific tiles or reverse
lookup indexes. Packages without the optional files keep their existing
behavior. A sidecar validation failure stays in staging and leaves the
previously installed package and active release selection intact.

## Native MOC overlap (2026-09-20)

Workspace dev Helm `asa` revision 31 uses image
`0.10.38-dev-20260920-native-overlap`. Assets remains revision 183.

The previous viewer sent its overview NSIDE 16 into overlap. For the same
Euclid 3.6.0 / DESI 3.2.0 selections this produced order 4: 9 cells, 5
components, while Assets queried order 8: 81 cells, 4 components. At equal
order 4 the two pixel arrays were identical; package versions were not the cause.

The viewer now omits the overview NSIDE for overlap. The server chooses the
highest common supported query order (currently 4 or 8), resolves each selected
public layer against its active installed package, checks the native FITS digest,
and calls the pinned Assets MOC Core `project` command offline. Projections are
cached by native SHA-256 and order. Public source identities and release filters
are retained. Explicit NSIDE still controls details/reverse lookup; the viewer
uses the result NSIDE for these requests. No package or activation migration is
required.

A legacy package without native precision metadata, or a selected Workspace
source with only overview coverage, limits automatic overlap to order 4. The
inspector shows actual ICRS/NESTED order and NSIDE, and notes that boundary
precision is limited by the source and HEALPix resolution. Unsupported explicit
refinement fails rather than promoting preview pixels.

Validation: build and 262 Node tests passed (2 skipped); the opt-in live catalog
contract installs current packages in an isolated temporary directory, projects
the actual native Euclid/DESI MOCs and compares all overlap pixels/component
counts with Assets. Production API comparison also verifies explicit order 4
and each order 8 component's details. Existing user package versions and active
releases are preserved.

Live Chromium verification selected Euclid/DESI and pressed G: the request omitted
NSIDE, the response and inspector showed order 8 / NSIDE 256, 81 cells and 4
components, with no page errors. Deployment is 1/1 Ready.

## Optional Assets reverse-lookup evidence (2026-09-25)

An authenticated Assets reverse lookup may return
`downloadPlan.coverageEvidence` independently of `downloadPlan.files`. Workspace
preserves this optional list through `/api/sky/reverse-lookup` and displays the
evidence in the overlap inspector. The accepted `evidenceKind` values include
`observation-footprint`, `published-moc`, `tile-footprint`, and `wcs-coverage`.
Source identity, instrument, filters, snapshot SHA-256, precision, completeness,
science-file scan status, and the summary remain evidence metadata; they are not
file entries or download requests. Coverage-only responses remain valid with no
files and no source or retrieval URL.

Workspace does not currently call Assets' overlap-details endpoint directly, so
its `publicSources[].coverageEvidence` response is not part of this client path.

## Assets evidence rollout (2026-09-25)

Dev Helm `asa` in `asa-workspace` advanced from revision 46 to 47 (chart 0.3.1)
using image
`0.10.38-dev-20260925-assets-reverse-evidence`, digest
`sha256:21915eb3e89c2b7a3ae03095fa99269a2b7b565593c6c250c4bab498bd47019f`.
The deployed pod reports the same digest and is 1/1 Ready with 0 restarts. A
local build of the current dirty source produced identical hashes for the server
modules and viewer bundle in this image. Helm lint with `--strict` passed, and
rendering the fresh live values showed no resource changes beyond the
Workspace Deployment image. The `/state` mount remained in place; the existing
20 GiB state and 5 GiB evidence PVCs stayed bound.

Validation: `npm run build` passed and the fresh `npm test` run passed 284 tests
with 2 optional skips. Public `GET /healthz`, catalog status, and resource
package listings passed before and after rollout. Catalog availability stayed
true, `stale` stayed false, its SHA-256 stayed the same, and all 11 package
records and their active release selections were unchanged. No package install
or activation route was called.

A live read-only `POST /api/sky/reverse-lookup` scoped to the public Euclid Q1
VIS source, order 4 cell 637, and `includeWorkspace: false` returned HTTP 200.
Workspace preserved one `published-moc` coverage evidence record with estimated
precision, even though the response had no downloadable files; Assets reported
the lookup available and non-truncated. Its frozen Q1 scope was still
incomplete at 336/352 committed partitions, so this is not a completeness claim.
This verifies the deployed evidence contract against an existing public source;
the later HST check below verifies that Assets now serves public
`observation-footprint` evidence. It does not establish that Workspace received
that live response.

## Public HST evidence cross-check (2026-09-25)

Assets' public coverage catalog revision
`3099ba026231b7eafe90037dfda0c286` listed three HST COSMOS observation layers,
all in ICRS/NESTED with native maximum order 10 and catalog projections at
orders 4 and 8. For `hst-mast-cosmos-obs-26442812`, the public FITS MOC SHA-256
was `bf27dec867f35b82b93c4b5d50f3675dbd453eb2c1b4b38efcee58b1e2c06851`; it
decoded to five native order-10 cells. Native cell 6978113 maps to available
order-8 cell 436132.

An anonymous Assets preview for that layer, order 8, and cell 436132 returned
HTTP 200 with `available: true`, `truncated: false`, and zero files. It included
one `observation-footprint` evidence record identifying MAST observation
26442812, proposal 12440, target ANY, and ACS/WFC `detection`; precision was
estimated, completeness incomplete, and `scienceFileScan` not-scanned. The
record's source snapshot SHA-256 was
`0ddeefa369484a91b74856cc61fa6ef3fed2673ee2f29b07d9da2dc36eac1fca`. This is
coverage provenance, not a downloadable file or a science-data retrieval path.

Workspace's package catalog reported `public-hst-footprints` 3.1.0 as
`not_installed`, with no active or available releases. Therefore no live
Workspace-to-Assets request was made for this HST row. The two targeted
synthetic tests passed for client field passthrough and viewer summary display;
they do not count as live end-to-end verification of this response.

The pre-rollout all-values snapshot was stored with mode 0600 at
`/tmp/asa-workspace-reverse-evidence.7DtThpzP/live-values.yaml`. Sanitized
pre/post public responses, the reverse-lookup contract summary, and test log are
in that temporary directory. No private CSST records were read, and no science
files were retrieved.
