# Workspace Domain Vocabulary

This workspace treats data production as a durable, inspectable operation rather than a page-specific action.

## Language

**Pipeline definition**: A versioned declaration of one production capability, its input requirements, executors, and output artifacts.

**Pipeline preset**: A server-persisted configuration copy of an available pipeline definition. Presets retain their own name, parameters, and pin state while runs keep the preset ID used at submission time.

**Production run**: One submitted execution of a pipeline. It owns status, steps, progress, errors, cancellation, retry, and provenance.

**Data artifact**: A named, checksummed file or connector handoff produced by a run.

**Region snapshot**: An immutable ICRS/NESTED HEALPix selection with source and overlap identifiers. Production inputs reference the snapshot, not a mutable canvas selection.

**Executor**: An implementation behind a pipeline seam, such as the built-in HTTP crawler, an MCP crawler, or the object-index matcher.

**Agent session**: A persisted conversation with attached workspace context and an auditable sequence of tool requests.

**Public coverage geometry**: Assets-authoritative geometry describing where a published public survey product reports coverage. It is evidence of coverage, not a promise that files are downloadable.
_Avoid_: user coverage, download inventory

**Protected Assets query**: A bounded, authenticated request from the Workspace server to Assets for a specific region and concrete public source identity. It returns scoped fine-coverage or data-unit information rather than exposing a general private index.
_Avoid_: browser Assets query, public tile index

**User coverage index**: Workspace-owned spatial provenance linking user assets, scans, MOCs, and their source metadata to local HEALPix cells. It is separate from public survey coverage geometry.
_Avoid_: public coverage index

**Overlap/download session**: A scoped operation that records an immutable region, the sources considered, and the results or expiry context used for overlap inspection or a download plan.
_Avoid_: mutable canvas selection

**Concrete public source identity**: The identity of an executable public data source, including survey, release or DR, product, and a sourceId or layerId. A survey-level value such as `public:desi` is not a source identity.
_Avoid_: survey-level public ID

The browser, CLI, and Agent use the same server-side command interfaces. The CLI is an HTTP client and never reads the metadata store or filesystem directly.
