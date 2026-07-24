import assert from "node:assert/strict";
import test from "node:test";

import { assertCatalogMcpSuccess } from "../src/catalog-mcp-client.js";

test("turns an MCP error payload into an explicit external failure", () => {
  assert.throws(() => assertCatalogMcpSuccess({
    error: { code: "INTERNAL", message: "execute search query: connection refused" },
  }), /Catalog MCP remote error: \[INTERNAL\].*connection refused/);
  assert.doesNotThrow(() => assertCatalogMcpSuccess({ data: { result: { hits: { hits: [] } } } }));
});
