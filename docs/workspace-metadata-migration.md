# Workspace local-state migration

The supported runtime uses local SQLite (WAL) and owned Elasticsearch. API and
scanner share one node. Scientific rows live in three v2 indices; large FITS
headers and catalog attributes live in compressed evidence chunks with bounded
record references. Workflow outputs and original scientific evidence remain files.

1. Pause Workspace scanning and suspend existing Workspace scan Jobs. Keep
   Warehouse and Assets unchanged. Retain the original state/search volumes.
2. Export a consistent SQLite backup. Copy state artifacts to a new local
   volume. Exclude the obsolete statistics checkpoint and transient files.
3. Run `scripts/migrate-workspace-search.py --source OWNED_OLD_ES --target
   OWNED_NEW_ES --metadata COPIED_SQLITE --output STAGING_DIRECTORY`.
   Use a local disk with room for scientific evidence. Review the receipt:
   current quality batches and distinct point identities are retained;
   superseded/unowned records remain in the original index. Never delete the
   original volume as part of conversion.
4. Stop API writes, take the final consistent SQLite backup and copy any changed
   Workflow/Agent/production control files. Copy the generated `workspace-scans`
   evidence directory into the new state volume. Migrate Connector credentials
   into the private `connector-credentials.json` file (0600); never print values.
5. With the pinned MOC Core available, run
   `npx tsx scripts/migrate-workspace-state.ts --root COPIED_STATE
   --search-receipt SEARCH_RECEIPT` against the copied state. The tool imports
   JSON history into SQLite and retains all original files. It publishes verified
   point-presence cells; original image-extent MOCs remain available as evidence.
   It keeps scanning paused and marks interrupted old tasks paused.
6. Deploy the API and independent worker with the new state claim and owned ES.
   Verify source identities, query points, detail attributes, MOC coverage,
   historical Workflow FITS and ZIP downloads. Record cold/warm latency before
   calling the cutover complete. Old tasks without the new checkpoint format
   remain history; submit a new scan to execute them locally.

Only recoverable configuration/catalog snapshots rotate to the latest three.
Referenced scientific evidence, Workflow outputs and source volumes are retained.

## November 6 completed cutover

Helm revision 150 deploys `0.0.1-dev-20261106-lightweight-r5`. API/worker use
`asa-workspace-state-local` (20 GiB); ES uses `asa-workspace-search-local` (30 GiB),
both `local-path` on `zjlab-ubuntu`. Original state, evidence, production and ES
volumes remain. Old state/evidence/production claims have
`helm.sh/resource-policy: keep`.

Search conversion retained 3,019,111 positions, 1,298,611 file records,
1,298,579 footprints and 12 published assets. Evidence copy verified all 746
files (6,149,925,910 bytes). Control/output verification checked 264 files
(26,405,504 bytes), with no mismatches. Five Workflow runs, ten Agent sessions,
four production runs, 22 Connectors and 23 assets remain available. API/worker
restart retained paused scanning; zero scans are queued/running and three are
paused. Measurements and test receipts are in the
[acceptance record](workspace-performance-refactor-20261106.md).

The host uses Helm 4.2.3, whose `--post-renderer` expects a plugin. For cutover,
a private temporary chart included an explicit retained-PVC template so the
three former Helm-managed claims stayed in the release with `keep` annotations.
Revision 150's stored manifest includes those annotations; subsequent normal
chart upgrades can omit the old claims and Helm retains them. New local claims
use `existingClaim` and remain independently owned. Recovery must use a matched
old state/search pair with scanning paused: revision 149 was an unsuccessful
intermediate deployment and revision 148 uses the former executors.

The final chart explicitly sets `serviceAccountName: default` and disables token
automount for API/worker/search; this clears a strategic-merge leftover of the
removed old account. API probes send `Host: localhost` for the MCP Host allowlist.
Validated local public-catalog cache avoids remote sync in the startup path.

Private receipts: `/tmp/workspace-lightweight-refactor-20261106/`; search and
evidence-copy receipts: `/home/aaron/.cache/workspace-refactor-20261106/`.
Keep credential contents and private Helm values out of public records.
