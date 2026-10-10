# Download Plan Workflow

## Contract

The Workspace download workflow has two independent inputs:

1. user-owned assets and MOCs define the selected region or overlap;
2. public package geometry identifies which public surveys/products cover it.

Only the second input contributes public download items. A downloadable source
manifest is JSON/CSV metadata and links, not scientific data. Each public item
must identify a concrete survey, release or DR, product, and sourceId;
`public:<survey>` is invalid and must be reported before execution. Scientific
files enter a Workspace task only after the user confirms a selected file set.

## Resolution steps

1. Capture the region locally, including ICRS/NESTED HEALPix order, cells,
   selected user assets, and provenance.
2. Intersect it with installed public package MOCs and local user MOCs. Derive
   the public layer IDs, order and cells sent to Assets; private region and scan
   details stay in Workspace.
3. For each public product selected by the user, classify availability as
   geometry-only, entrypoint-only, candidate/incomplete, or tile-resolved.
4. For public data units, the Workspace server calls Assets with its
   server-side API Key and public selectors. The browser never receives the
   credential. Workspace requires the keyed result and never retries
   anonymously.
5. Validate returned survey, release/DR, product, sourceId, requested region,
   actual HEALPix order, index revision, query snapshot and expiry before
   presenting source units.
6. Keep the raw public response in request/browser memory. Exported JSON/CSV
   remains a source manifest. User assets provide spatial provenance and
   constraints, not public download items.
7. Require explicit user confirmation for entrypoint-only or incomplete
   candidates. A geometry-only result remains visible but is not executable.
8. At execution time, preserve the exact user-confirmed file set. A later live
   lookup may find more files, but cannot add them to an existing task. Any
   changed file set requires a new preview and confirmation.

## Assets Lookup Boundary

Assets owns public reverse lookup, native indexes, footprints and immutable
query snapshots. Anonymous Assets requests receive a small preview; a valid
API Key authorizes the full scoped, paginated lookup. Workspace uses only its
server-side API Key. Each new lookup starts from the current Assets state, and
its cursor continues that same frozen snapshot. `page.hasMore=false` means the
returned cursor page chain has ended. `querySnapshot.queryExhausted` tracks
completion of the underlying bounded query/search and can remain false under
query limits or gaps. `truncated` reports source/query limits or omitted
evidence and can remain true after page exhaustion. `inventoryComplete`
independently records completeness of the declared source inventory. A fully
drained export may therefore have `page.hasMore=false`,
`querySnapshot.queryExhausted=false`, `inventoryComplete=false` and
`truncated=true`.

Workspace sends only public layer IDs, HEALPix order/cells, public unit IDs,
and cursor/snapshot selectors. CSST scan IDs, files, MOCs, paths, hashes and
parent directories remain in Workspace. Public lookup, footprint,
native-index and snapshot responses remain in request/browser memory and are
not cached or copied into Workspace artifacts or recipes.

## Phase 2 MVP Preview and Task

This section defines the phase-two contract; it is not a deployment or
verification record.

The stateless preview endpoint accepts a `RegionDownloadSelection` directly.
Optional snapshot, index revision and exact native units constrain or identify
the lookup. This example uses the registered Legacy DR10 Coadded-imaging layer
and a real brick identity:

```json
{
  "layerIds": ["source-units-legacy-surveys-legacy-dr10-coadded-imaging"],
  "order": 8,
  "cells": [436132],
  "units": [
    {
      "layerId": "source-units-legacy-surveys-legacy-dr10-coadded-imaging",
      "unitKind": "brick",
      "unitId": "1498p020"
    }
  ]
}
```

`POST /api/sky/download-plan/preview` accepts that raw selection and returns an
HTTP body shaped as `{ "preview": { ... } }`. The preview contains `selection`,
`inventory`, `unavailable`, `notes`, optional structured `notices`, `limits`,
`querySnapshotId`, optional `nativeUnitIndexRevision` and `planSha256`. Notice
codes identify incomplete inventory, estimated unit coverage, unverified file
metadata, and truncated results; the viewer localizes these advisories and
groups repeated notices by source. `notices` is optional for compatibility
with older preview responses and does not participate in `planSha256`. The
viewer unwraps the `preview` property. It creates no session or production
artifact; the response remains transient until the user selects files and
confirms the task.
The preview inventory deduplicates identical physical URIs into one file entry,
even when more than one native unit refers to that URI.

The viewer requests `Accept: text/event-stream` on the same endpoint. `progress`
events report the lookup or metadata stage and completed/total counts; `batch`
events contain discovered file and unavailable-source deltas. Only
`complete` with `{ "preview": { ... } }` provides the validated selection,
inventory and fingerprint. The server sends a heartbeat comment every ten
seconds while waiting, disables proxy buffering, and preserves the JSON
response for clients that do not request streaming. An `error` event terminates
the stream; typed errors include `statusCode` and optional `retryAfterSeconds`.

Files discovered during a preview remain read-only until `complete`. Stopping
retains partial files for inspection and requires a fresh preview before
confirmation. Closing the preview, changing region/template, or leaving data
production aborts active upstream requests and prevents queued source requests
from starting. Preview results and request-local metadata buffers are transient;
there is no persisted preview session. Snapshot, expiry, revision, final
inventory hash and confirmation validation still apply.

Data production uses a compact horizontal workflow above execution history,
with parameters in the inspector. History fills the remaining main area;
selecting a run or workflow node opens its logs, which can be closed. Polling
preserves the selected run, scroll positions and keyboard focus. File previews
temporarily occupy the history area, and successful confirmation returns to
execution history.

The desktop workflow first offers the native units already loaded from the
frozen Assets snapshot, capped at 128 selectable units. It initially selects
one hit per survey; users can expand this selection before requesting source
file metadata. The full component cells and layer selection are preserved.
This bounds the default source metadata work without limiting region lookup
pagination or JSON/CSV source-manifest export. Changing native-unit selection
clears the old file preview and all selected files; a new preview is required
before confirmation. Clearing every native unit disables preview. File
candidates within the file-count, per-file and task-size limits start selected;
preview alone never creates a download run, which still requires confirmation.

The first four public file adapters are bounded to source-returned identities
and locations: Euclid Q1 uses the official returned `fileURI`; DESI resolves an
exact Tile leaf; Legacy Surveys uses the returned product URI; HST resolves
official observation products to public `SCIENCE` FITS files. Do not crawl a
source root, derive filenames from geometry, or invent an ERO file mapping.

After confirmation, the existing `POST /api/production-runs` pipeline
`overlap-download@1` accepts `publicDownload` in the run request. Reuse
`preview.selection` and copy `preview.planSha256` into `previewSha256`; submit
only the file URLs the user selected from `preview.inventory`. The request also
includes the matching region snapshot. Values in angle brackets are placeholders
copied from the preview:

```json
{
  "pipelineKey": "overlap-download@1",
  "region": {
    "coordinateFrame": "ICRS",
    "ordering": "NESTED",
    "nside": 256,
    "pixels": [436132],
    "sourceIds": []
  },
  "publicDownload": {
    "selection": {
      "layerIds": ["source-units-legacy-surveys-legacy-dr10-coadded-imaging"],
      "order": 8,
      "cells": [436132],
      "querySnapshotId": "snapshot-from-preview",
      "nativeUnitIndexRevision": "revision-from-preview",
      "units": [
        {
          "layerId": "source-units-legacy-surveys-legacy-dr10-coadded-imaging",
          "unitKind": "brick",
          "unitId": "1498p020"
        }
      ]
    },
    "previewSha256": "<preview.planSha256>",
    "selectedFileUrls": ["<selected URL from preview.inventory.files>"]
  }
}
```

Before creating the task, the server re-fetches the same Assets query snapshot
and verifies the preview digest and that every selected URL belongs to its
candidate inventory. A confirmed task may persist only its chosen file
inventory (source identity, source URI, size, checksum and relative destination)
and progress. This inventory is frozen for that task: later lookup results do
not add files. For example, a task confirmed with 10 files stays at 10 if a
later Assets lookup returns 12. The raw response, unselected candidates, preview
and shared public index are not task artifacts.

Workspace downloads full source files under their source access policy; Assets
does not retrieve them, and the MVP does not produce region cutouts. A task can
select up to 128 files; there is no per-file or aggregate byte quota. Files are
streamed to `.part` files. Transient HTTP or stream failures are retried up to
three times with increasing delays. Interrupted bytes resume with HTTP Range
only when the source provides a usable object validator and the partial
response matches it. Without a reliable validator, Workspace discards the
partial file and retries from byte zero rather than joining bytes that may
belong to different source versions. A terminated response reports the file
and transfer error; source-side and network/proxy disconnects cannot always be
distinguished by the client. Available storage and source behavior determine
whether a transfer can complete. Executor concurrency defaults to 4 and accepts
values from 1 through 16. Allow public HTTP sources only. Tasks write to Workspace runtime storage
in Dev; delivery to a desktop user follows the existing Workspace download
path. Connector-backed destinations require connector verification first.
The desktop preview flow registers a local Connector after download. To scan
those files, register a user asset with its real source identity and FITS/CSV
coverage recipe, link the Connector, then submit a separate scan. It does not
offer automatic Warehouse handoff for an unregistered output Connector. The
existing API handoff remains available for a destination that already has the
required asset and recipe.

Each file is retried independently. After its retries are exhausted, that file
is marked failed and the queue continues. Fully verified files remain in the
output Connector; incomplete `.part` bytes do not count as downloaded files.
When every selected file fails, the run is failed. When every file verifies,
the run succeeds. When some verify and some fail, the verified files are
registered and the run ends as partially successful; the run history is amber
and its download-node logs retain each skipped file's error.
The supported scope is the desktop flow over existing public sources; this
contract does not extend support to new operating systems, mobile,
login-required sources or S3 downloads. Existing local scan and overlap
workflows remain as documented.

## Failure behavior

- Assets unavailable: retain local geometry and overlap; show reverse lookup as
  unavailable and allow the user to retry.
- No tile match: retain the public coverage result, but create no executable
  item.
- Incomplete candidates: show them for review and require confirmation.
- Identity mismatch, expired revision, or invalid sourceId: reject the result.
- Partial results: preserve returned items and mark the query incomplete;
  report page exhaustion separately from source inventory completeness.

This workflow deliberately separates “the survey says this area is covered”
from “these exact files can currently be downloaded.”
