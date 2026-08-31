# Workspace Domain Vocabulary

This workspace treats data production as a durable, inspectable operation rather than a page-specific action.

- **Pipeline definition**: a versioned declaration of one production capability, its input requirements, executors, and output artifacts.
- **Production run**: one submitted execution of a pipeline. It owns status, steps, progress, errors, cancellation, retry, and provenance.
- **Data artifact**: a named, checksummed file or connector handoff produced by a run.
- **Region snapshot**: an immutable ICRS/NESTED HEALPix selection with source and overlap identifiers. Production inputs reference the snapshot, not a mutable canvas selection.
- **Executor**: an implementation behind a pipeline seam, such as the built-in HTTP crawler, an MCP crawler, or the object-index matcher.
- **Agent session**: a persisted conversation with attached workspace context and an auditable sequence of tool requests.

The browser, CLI, and Agent use the same server-side command interfaces. The CLI is an HTTP client and never reads the metadata store or filesystem directly.
