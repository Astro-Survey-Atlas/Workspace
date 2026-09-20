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

Workspace must not copy or maintain Assets' complete tile/file/shard index.
When a user asks for public data units, Workspace's server may call an
authenticated Assets endpoint for the requested region and explicit
survey/release/product/source identity. Results are scoped to the operation,
record the Assets revision and expiry, and are not exposed as a general index.

User assets constrain the region and overlap calculation; they are never
converted into public download items.
