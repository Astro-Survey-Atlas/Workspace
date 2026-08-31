import assert from "node:assert/strict";
import test from "node:test";

import { discoverSourceFiles } from "../src/source-crawler.js";

test("recognizes a direct data-file URL without downloading its body", async () => {
  const methods: string[] = [];
  const result = await discoverSourceFiles("https://example.test/catalog.fits", {
    fetchImpl: async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(null, { status: 200, headers: { "content-type": "application/fits", "content-length": "42" } });
    },
  });
  assert.deepEqual(result.files, [{ url: "https://example.test/catalog.fits", name: "catalog.fits", sizeBytes: 42 }]);
  assert.deepEqual(methods, ["HEAD"]);
});

test("extracts data files from HTML and XML directory listings", async () => {
  const html = `<html><a href="tile-a.fits">A</a><a href="notes.html">Notes</a><a href="https://cdn.example.test/tile-b.csv">B</a></html>`;
  const result = await discoverSourceFiles("https://example.test/data/", {
    fetchImpl: async (_input, init) => init?.method === "HEAD"
      ? new Response(null, { status: 200, headers: { "content-type": "text/html" } })
      : new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
  });
  assert.deepEqual(result.files, [
    { url: "https://example.test/data/tile-a.fits", name: "tile-a.fits" },
    { url: "https://cdn.example.test/tile-b.csv", name: "tile-b.csv" },
  ]);

  const xml = "<ListBucketResult><Key>release/a.fits</Key><Key>release/readme.txt</Key></ListBucketResult>";
  const xmlResult = await discoverSourceFiles("https://example.test/", {
    fetchImpl: async (_input, init) => init?.method === "HEAD"
      ? new Response(null, { status: 405, headers: { "content-type": "application/xml" } })
      : new Response(xml, { status: 200, headers: { "content-type": "application/xml" } }),
  });
  assert.deepEqual(xmlResult.files, [
    { url: "https://example.test/release/a.fits", name: "a.fits" },
    { url: "https://example.test/release/readme.txt", name: "readme.txt" },
  ]);
});

test("does not turn MOC JSON or an ordinary documentation page into a file", async () => {
  const result = await discoverSourceFiles("https://example.test/moc?fmt=json", {
    fetchImpl: async (_input, init) => init?.method === "HEAD"
      ? new Response(null, { status: 200, headers: { "content-type": "application/json" } })
      : new Response('{"cells":[1,2]}', { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(result.files.length, 0);
  assert.match(result.reason ?? "", /未发现可下载文件/);
});

test("filters listing links whose host resolves to a private address", async () => {
  const result = await discoverSourceFiles("https://example.test/data/", {
    resolveHostname: async (hostname) => hostname === "example.test" ? ["203.0.114.20"] : ["10.0.0.8"],
    fetchImpl: async (_input, init) => init?.method === "HEAD"
      ? new Response(null, { status: 200, headers: { "content-type": "text/html" } })
      : new Response('<a href="https://private.example/catalog.fits">private</a>', { status: 200, headers: { "content-type": "text/html" } }),
  });
  assert.equal(result.files.length, 0);
  assert.match(result.reason ?? "", /未发现可下载文件/);
});
