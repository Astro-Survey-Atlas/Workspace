# Download Plan Workflow

## Contract

The Workspace download workflow has two independent inputs:

1. user-owned assets and MOCs define the selected region or overlap;
2. public package geometry identifies which public surveys/products cover it.

Only the second input contributes public download items. A plan item must
contain a concrete survey, release or DR, product, and sourceId. `public:<survey>`
is invalid and must be reported before execution.

## Resolution steps

1. Capture an immutable region snapshot, including ICRS/NESTED HEALPix order,
   cells, selected user assets, and provenance.
2. Intersect that snapshot locally with installed public package MOCs and local
   user MOCs. This works even when Assets is unavailable.
3. For each public product selected by the user, classify availability as
   geometry-only, entrypoint-only, candidate/incomplete, or tile-resolved.
4. If public data units are requested, the Workspace server calls Assets with
   its server-side credential and the explicit source identity. The browser
   never receives the credential.
5. Validate returned survey, release/DR, product, sourceId, requested region,
   actual HEALPix order, revision, and expiry before creating plan items.
6. Put only concrete public source units in the immutable download plan. Keep
   user assets as spatial provenance and constraints, not download items.
7. Require explicit user confirmation for entrypoint-only or incomplete
   candidates. A geometry-only result remains visible but is not executable.
8. At execution time, refresh expired temporary download authorization without
   changing the recorded region or source identities. Changes create a new plan
   revision rather than silently mutating history.

## Assets API boundary

Assets remains the authority for public reverse lookup and tile derivation. Its
future server-to-server API should accept a bounded region/cell set, explicit
survey/release/product/layer identity, purpose (`overlap` or `download-plan`),
and a revision/expiry context. It should return only requested-region matches,
actual order and precision, availability state, and concrete public source
units. It should enforce limits on area, cells, results, response size, and
time-to-live.

Public catalog and package geometry must not expose a full private reverse
index. Assets' own UI may use an internal authorized path; Workspace uses only
the scoped contract.

## Failure behavior

- Assets unavailable: retain local geometry and overlap; show reverse lookup as
  unavailable and allow the user to retry.
- No tile match: retain the public coverage result, but create no executable
  item.
- Incomplete candidates: show them for review and require confirmation.
- Identity mismatch, expired revision, or invalid sourceId: reject the result.
- Partial results: preserve returned items and mark the plan incomplete; never
  present it as a complete download set.

This workflow deliberately separates “the survey says this area is covered”
from “these exact files can currently be downloaded.”
