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
