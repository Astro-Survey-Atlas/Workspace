# FITS position and Aladin audit, November 3

The reported W1 / NSIDE 16 NESTED pixel 815 discrepancy exists before browser
rendering. Direct source-header comparisons now establish that the 11 reported
files contain internally inconsistent WCS metadata. Neither Warehouse header
preservation nor Workspace's numeric coordinate conversion introduced those
values. The processing pipeline accepts and publishes the questionable WCS
without checking its declared pixel scale. Separate direct-coordinate,
Inspector and product-type gaps remain. No running-code fix, deployment, scan,
repair or index write was performed.

The intended marker represents a real file/HDU observation position from FITS
metadata. It does not require image pixels, source detection or an image preview.
Image, spectrum and other product types must be independent of whether a
coordinate describes an image center or a pointing.

## Source FITS versus Warehouse and Workspace

The follow-up source audit read the primary and first science HDU headers of
all 11 reported files and one normal control from the same W1 asset. All 12
filenames contain CRS, so this category alone does not identify invalid WCS.
Each file required six 2,880-byte Range requests: 72 requests and 207,360 bytes
in total. The reads stopped at each header's END card without reading science
arrays. Range offsets and stable object ETags were checked.

For every file, both original source headers, through END and including card
comments and spacing, match the retained headers byte for byte. SHA-256 hashes
were recorded privately. Warehouse therefore did not corrupt or reinterpret
the stored WCS cards during header preservation.

There is independent evidence of a source-metadata problem: PIXSCAL1 and
PIXSCAL2 declare 0.074 arcsec/pixel, while the CD matrix column norms imply
wildly different scales in all 11 reported files. No project coordinate code,
FITS parser or Astropy was used for this arithmetic; selected values were read
directly from the source ASCII cards.

| Source file | Declared scale, arcsec/pixel | CD axis 1, arcsec/pixel | CD axis 2, arcsec/pixel |
| --- | ---: | ---: | ---: |
| Reported first file, exposure 10600092619 / detector 08 | 0.074 | 1,645.424364 | 20,862.741893 |
| Normal CRS control, exposure 10600025732 / detector 19 | 0.074 | 0.073999285 | 0.073998909 |

The first file's discrepancy is approximately 22,235 times on one axis and
281,929 times on the other. Across all 11 reported files the ratios range
from 12,326 to 417,045. At the declared scale, its 9216 by 9232 detector is
approximately 0.18944 by 0.18977 degrees. The enormous WCS-derived coverage is
not consistent with that source metadata. The normal control agrees with its
declared scale on both axes.

A separate handwritten inverse TAN calculation using only Python's math
library reproduces the stored coordinates for all 12 files within 1e-9 degrees.
For the first file it yields 123.34584300235879 / 11.555288211930865; the index
contains 123.3458430023588 / 11.555288211930852. Thus Workspace did not create
the displaced center through its numeric transformation, and agreement is
independent of the shared Astropy implementation.

The attribution for these 11 files is therefore:

- Source: internally inconsistent WCS metadata, unreliable for publishing
  image extent as valid coverage. This is a coordinate-metadata finding, not
  a claim that every CRS file or the entire FITS payload is corrupt.
- Warehouse: source cards are preserved correctly; the WCS path lacks a check
  for this source-metadata inconsistency before accepting coverage.
- Workspace: its WCS center computation and index association reproduce the
  input correctly, but it also trusts this WCS. Missing direct-coordinate-key
  support and product classification are separate confirmed limitations.
- Aladin: the real image-marker path works; no rendering failure explains the
  zero positions in the frozen 815 region.

This supersedes the initial broad attribution to Workspace coordinate
interpretation as the primary cause. Recovering calibrated coordinates or
correcting existing coverage/positions is subsequent work and was not run.

## Live API reproduction

Read-only requests used only asset
`user-d4639a71-b684-4789-977f-75e1e150c641` (CSST Simulation W1), ICRS/NESTED
regions and bounded result pages.

| Check | Result |
| --- | --- |
| Points in the entire pixel 815, without a viewport/FOV filter | 0 |
| Point anchor in pixel 815 | null |
| Covering image records at RA 303.47877 / Dec 28.75543 | 11 |
| Nearby catalog objects at that coordinate | 0 |
| W1 point records over the whole sky | 356,112 |
| First listed file retrievable at its stored coordinate | yes |
| Independent header calculation reproduces all 11 stored centers | 11/11 |

The first listed file is
`CSST_MSC_MS_CRS_20230922225759_20230922230029_10600092619_08_L0_V01.fits`,
HDU 1. Its point ID is
`10acc3bc5c6b9a5f60a8d49dbc1634889094c1421cbbd7b16fa4d632b0c90eb6`.

| Coordinate meaning | RA (degrees) | Dec (degrees) | NSIDE 16 pixel |
| --- | ---: | ---: | ---: |
| User click | 303.47877 | 28.75543 | 815 |
| Stored and recomputed WCS image center | 123.3458430023588 | 11.555288211930852 | 288 |
| Primary RA_OBJ/DEC_OBJ and RA_PNT0/DEC_PNT0 | 269.061405 | 75.945966 | 735 |

The stored order-8 HEALPix pixel, 73787, equals an independent healpixjs
calculation. None of the 11 indexed centers is in pixel 815. This excludes a
small initial FOV and an Aladin-only failure as explanations for this case.
Adding support for RA_OBJ/DEC_OBJ alone would not place this file in pixel 815.

## Coordinate interpretation

The retained primary header contains RA_OBJ/DEC_OBJ and both start/end
RA_PNT0/DEC_PNT0 and RA_PNT1/DEC_PNT1. These cards were retained, rather than
lost while reading headers. The direct-coordinate extractor in
`src/sky-point-coordinates.py` recognizes only RA_TARG/DEC_TARG, RA/DEC and
RA_DEG/DEC_DEG in the primary header. It attempts a direct-coordinate fallback
only when no science WCS image center was produced.

A minimal in-memory replay of the actual primary header produces
`no usable science WCS or target coordinates`. Copying its RA_OBJ/DEC_OBJ
values into recognized RA/DEC keys, in memory only, produces the expected
pointing at 269.061405 / 75.945966. This isolates the keyword-support gap.

The science WCS contains this CD matrix, with header comments declaring
degrees per pixel:

```text
-0.25624317844641226   3.202394443287223
 0.37847774157586506  -4.83001898090824
```

Independent Astropy calculations and replays of both Workspace's position
converter and Warehouse's FITS worker agree on the stored center. Warehouse's
worker accepts the WCS as usable. Under this WCS the user's click maps inside
the 9216 by 9232 image array, despite being approximately 139.689 degrees from
the computed center. Thus the covering-file list is reproducible from the
retained metadata; it does not independently establish scientifically valid
coverage there. Current validation accepts finite WCS results without checking
this scale or its disagreement with explicit target/pointing coordinates.

The November 2 audit separately checked six bounded source-header ranges,
17,280 bytes total, and confirmed the critical CD cards for this example.
That evidence did not prove whole-header byte equality or justify rejecting
every file with a CRS filename. The initial November 3 checks reused retained
headers; the follow-up source audit above now establishes complete primary
and science-header equality through END for the 12 checked files and the
source's internal pixel-scale contradiction. Appropriate instrument-specific
coordinate precedence and recovery remain separate work.

## Index, API and viewer boundaries

The derived-index path stores converted coordinates and keeps the source
headers. The sample is returned by a bounded point query at its stored
coordinate, and its HEALPix association is correct. There is no evidence here
of a successful center being dropped from that index.

Aladin's `appendRecords` passes all returned positions, including image centers
and pointings, to `A.source` and `catalog.addSources`. A separate exclusion of
those roles applies only to catalog cross-match markers after the normal
markers have been added.

A real Dev browser check entered W1 through its existing **查看数据点** action
at an indexed position. The API returned a W1 image-center record and Aladin
painted its marker at FOV 0.5. The catalog canvas contained 3,472 painted alpha
pixels; the saved screenshot confirms the green position marker. There were
no Workspace API failures, page errors or unexpected writes. This validates
the image-marker rendering path, not every viewport/layout case. The in-app
Browser had no connected instance; the check used the project's existing
standalone Playwright workflow and a fresh isolated browser context.

The Inspector's **附近星表对象** explicitly excludes image_center and pointing
records. Its zero therefore describes catalog matches, not all observation
files or all sky-position markers. Covering images are queried separately
through WCS footprints and can have centers outside the selected region.

## Related confirmed gaps

`pointDocument` in `src/derived-repairs.ts` assigns modality from position_role:
image_center becomes image, everything else becomes pointing. A header-only
control with a one-dimensional WAVE spectral axis and valid target RA/Dec
produced modality pointing, confirming that this path does not classify the
product from FITS content.

The Workspace local FITS scan additionally filters converted rows to
image_center before indexing and requires celestial-image WCS coverage.
That is a separate limitation for direct-coordinate-only and spectral files;
it is not the path that explains the already-indexed W1 sample above.

Follow-up implementation should preserve coordinate provenance and product
type separately, support the relevant explicit FITS coordinate keys and
validate WCS/pointing disagreements before publishing or replacing derived
positions and coverage. Existing data correction is separate from this audit.

## Private reproduction artifacts

`/tmp/workspace-w1-coordinate-audit-path` points to
`/tmp/workspace-w1-coordinate-audit-20261103-ohnzmc0k/`.

- `audit.py --symptom` reproduces the covering-files/zero-position discrepancy
  with an intentional failing assertion. Omitting `--symptom` validates the
  index/reconversion checks while retaining the discrepancy in its summary.
- `summary.json`, `all11-header-checks.json`, `healpix-check.json`,
  `warehouse-worker-replay.json`, `direct-header-reproduction.json` and
  `spectrum-modality-check.json` capture the boundary checks.
- `live-render.mjs`, `live-render-check.json` and `live-w1-markers.png` capture
  the real API/browser marker check. The script uses the repository's existing
  Playwright installation and existing Dev port-forward on 19309.

Raw retained headers and complete API responses stay in this private directory.
No credentials, raw headers or source arrays were committed to the repository.

The subsequent source attribution receipt is
`/tmp/workspace-fits-source-triage-20261103-cxuhzvxp/`, also referenced by
`/tmp/workspace-fits-source-triage-path`. Its source responses and full raw
headers remain private. `read-source-headers.mjs` performs the bounded source
reads with the existing in-cluster credentials, without emitting credentials.
`verify-source-triage.py` independently validates card preservation, pixel-scale
inconsistency and TAN-center agreement using only Python's standard library.
It passes all 12 comparisons; `triage-summary.json` and
`independent-TAN-files.json` record the safe numeric results.

The subsequent independent five-per-group W1–W4 source sample is documented in
[the W1–W4 audit](csst-w1-w4-header-sample-audit-20261103.md). Its 20 new files
yielded 19 passes and one W4 metadata-review case, without reproducing the
severe scale conflict in the original 11 problem-selected files. These small
and differently selected samples must not be pooled into a population rate.
