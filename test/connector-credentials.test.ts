import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KubernetesConnectorCredentialStore } from "../src/connector-credentials.js";

test("managed connector credentials round-trip through the Kubernetes Secret API", async () => {
  let secret: { data: Record<string, string> } | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, "Bearer test-token");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stringData?: Record<string, string> } : undefined;
      if (request.method === "GET") {
        response.statusCode = secret ? 200 : 404;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(secret ?? { message: "not found" }));
        return;
      }
      if (request.method === "POST" || request.method === "PATCH") {
        secret = { data: Object.fromEntries(Object.entries(body?.stringData ?? {}).map(([key, value]) => [key, Buffer.from(value).toString("base64")])) };
        response.statusCode = request.method === "POST" ? 201 : 200;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(secret));
        return;
      }
      if (request.method === "DELETE") {
        secret = undefined;
        response.statusCode = 200;
        response.end("{}");
        return;
      }
      response.statusCode = 405;
      response.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(path.join(os.tmpdir(), "astro-credential-store-"));
  const tokenPath = path.join(directory, "token");
  await writeFile(tokenPath, "test-token\n", "utf8");
  try {
    const store = new KubernetesConnectorCredentialStore({ namespace: "astro-data-workspace", apiUrl: `http://127.0.0.1:${address.port}`, tokenPath });
    const reference = store.managedReference("connector-12345678-abcd-4abc-8abc-1234567890ab");
    assert.equal(reference, "astro-data-workspace/astro-connector-12345678-abcd-4abc-8abc-1234567890ab");
    assert.equal(await store.get(reference), undefined);

    await store.put(reference, { accessKeyId: "saved-access", secretAccessKey: "saved-secret", endpoint: "https://s3.example" });
    assert.deepEqual(await store.get(reference), { accessKeyId: "saved-access", secretAccessKey: "saved-secret", endpoint: "https://s3.example" });
    assert.ok(!JSON.stringify(secret).includes("saved-secret"));

    await store.put(reference, { accessKeyId: "updated-access", secretAccessKey: "updated-secret", endpoint: "https://s3.example" });
    assert.equal((await store.get(reference))?.accessKeyId, "updated-access");
    await store.remove(reference);
    assert.equal(await store.get(reference), undefined);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
