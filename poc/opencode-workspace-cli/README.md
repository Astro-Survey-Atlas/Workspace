# OpenCode Workspace CLI PoC

This optional client keeps Workspace as the owner of workflow runs, human decisions, artifacts, and lineage. OpenCode reaches Workspace only through the compiled Workspace CLI. The primary agent can delegate read-only catalog, workflow, and quality reviews; all writes require OpenCode's `workspace_action` permission prompt.

The adapter rejects Workspace Agent session APIs and direct catalog or FITS cutout MCP calls. Scientific operations must use a registered Workspace Workflow. The OpenCode project configuration denies shell and file tools.

## Run

Build the CLI from the Workspace root, then set `ASTRO_WORKSPACE_URL` to a running Workspace API origin. Start OpenCode from this directory with the `workspace-operator` agent. For a read-only check, ask it to list Workflow keys and versions. A run creation or human decision must trigger the `workspace_action` confirmation prompt.

The adapter accepts `TRACEPARENT` and `TRACESTATE` when supplied by the host and passes them through the CLI. Workspace remains responsible for its own spans and metrics.

The PoC does not install OpenCode into the Workspace application or make it a second source of session or scientific state.
