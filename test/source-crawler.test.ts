import assert from "node:assert/strict";
import test from "node:test";

import { discoverSourceFiles, resolveSourceInventory, type DirectFileSourceUnit, type SourceUnit } from "../src/source-crawler.js";

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

const directFileUnit: DirectFileSourceUnit = {
  sourceId: "public:desi:dr1:iron",
  unitId: "file:public:desi:dr1:iron",
  resolver: "direct-file@1",
  url: "https://example.test/tile-406.fits",
};

test("direct-file units enrich metadata via HEAD and keep a canonical path", async () => {
  const methods: string[] = [];
  const inventory = await resolveSourceInventory([directFileUnit], {
    fetchImpl: async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/fits", "content-length": "1234", etag: '"v1"', "last-modified": "Wed, 09 Sep 2026 00:00:00 GMT" },
      });
    },
  });
  assert.deepEqual(methods, ["HEAD"]);
  assert.equal(inventory.schemaVersion, 1);
  assert.match(inventory.inventorySha256, /^[0-9a-f]{64}$/);
  assert.equal(inventory.files.length, 1);
  assert.equal(inventory.files[0]?.sizeBytes, 1234);
  assert.equal(inventory.files[0]?.etag, '"v1"');
  assert.equal(inventory.files[0]?.url, directFileUnit.url);
  assert.match(inventory.files[0]?.relativePath ?? "", /^sources\/[^/]+\/[^/]+\/tile-406\.fits$/);
  assert.equal(inventory.units[0]?.status, "resolved");
});

test("http-directory units keep only same-origin immediate child files", async () => {
  const html = `<html><a href="tile-a.fits">a</a><a href="nested/tile-b.fits">b</a><a href="https://cdn.example.test/x.fits">c</a><a href="../up.fits">d</a><a href="subdir/">dir</a></html>`;
  const inventory = await resolveSourceInventory([{
    sourceId: "public:desi:dr1:iron",
    unitId: "dir:public:desi:dr1:iron",
    resolver: "http-directory@1",
    directoryUrl: "https://example.test/data/",
  }], {
    fetchImpl: async (_input, init) => init?.method === "HEAD"
      ? new Response(null, { status: 200, headers: { "content-type": "text/html" } })
      : new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
  });
  assert.equal(inventory.files.length, 1);
  assert.equal(inventory.files[0]?.url, "https://example.test/data/tile-a.fits");
  assert.match(inventory.files[0]?.relativePath ?? "", /\/tile-a\.fits$/);
  assert.equal(inventory.units[0]?.status, "resolved");
});

const desiTileUnit = {
  sourceId: "public:desi:dr1:iron",
  unitId: "desi:dr1:iron:406:20210406",
  resolver: "desi-tile@1",
  directoryUrl: "https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/tiles/cumulative/406/20210406/",
  release: "dr1",
  redux: "iron",
  tileId: 406,
  lastNight: "20210406",
} as const;

test("desi-tile units expand into the native hierarchy and attach official checksums", async () => {
  const checksum = `${"b".repeat(64)}  coadd-0-1-thru20210406.fits\n`;
  const listing = `<html><a href="coadd-0-1-thru20210406.fits">coadd</a><a href="redux_iron_tiles_cumulative_406_20210406.sha256sum">sums</a></html>`;
  const requestedUrls: string[] = [];
  const inventory = await resolveSourceInventory([desiTileUnit], {
    fetchImpl: async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith(".sha256sum")) {
        return new Response(checksum, { status: 200, headers: { "content-type": "text/plain" } });
      }
      return new Response(listing, { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  assert.equal(inventory.units[0]?.status, "resolved");
  assert.equal(inventory.files.length, 2);
  const coadd = inventory.files.find((file) => file.relativePath.endsWith("coadd-0-1-thru20210406.fits"));
  assert.ok(coadd);
  assert.equal(coadd.sha256, "b".repeat(64));
  assert.match(coadd.relativePath, /\/desi\/dr1\/spectro\/redux\/iron\/tiles\/cumulative\/406\/20210406\/coadd-0-1-thru20210406\.fits$/);
  assert.ok(requestedUrls.some((url) => url.endsWith(".sha256sum")));
  const paths = inventory.files.map((file) => file.relativePath);
  assert.deepEqual(paths, [...paths].sort());
});

test("desi-tile units reject declarations inconsistent with the directory URL without any network", async () => {
  const inventory = await resolveSourceInventory([{ ...desiTileUnit, tileId: 407 }], {
    fetchImpl: async () => { throw new Error("network must not be touched"); },
  });
  assert.equal(inventory.files.length, 0);
  assert.equal(inventory.units[0]?.status, "unavailable");
  assert.match(inventory.units[0]?.reason ?? "", /单元声明与目录 URL 不一致/);
});

test("desi-tile units only accept the exact tiles/cumulative leaf path", async () => {
  const inventory = await resolveSourceInventory([{
    ...desiTileUnit,
    directoryUrl: "https://data.desi.lbl.gov/public/dr1/spectro/redux/iron/tiles/cumulative/",
  }], {
    fetchImpl: async () => { throw new Error("network must not be touched"); },
  });
  assert.equal(inventory.files.length, 0);
  assert.match(inventory.units[0]?.reason ?? "", /必须精确匹配/);
});

test("unknown resolver kinds surface as unavailable units instead of throwing", async () => {
  const inventory = await resolveSourceInventory([{
    sourceId: "public:x",
    unitId: "unit:x",
    resolver: "ftp-mirror@1",
  } as unknown as SourceUnit]);
  assert.equal(inventory.files.length, 0);
  assert.equal(inventory.units[0]?.status, "unavailable");
  assert.match(inventory.units[0]?.reason ?? "", /未知解析器/);
});

test("duplicate relative paths in the inventory are rejected instead of renamed", async () => {
  await assert.rejects(() => resolveSourceInventory([directFileUnit, { ...directFileUnit }], {
    fetchImpl: async () => new Response(null, { status: 200, headers: { "content-type": "application/fits" } }),
  }), /清单相对路径冲突/);
});

test("mast-observation resolves only public SCIENCE FITS products from the official product API", async () => {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const inventory = await resolveSourceInventory([{
    sourceId: "public:hst:mast-2026:acs:layerId=hst-acs",
    unitId: "hst-observation-26442812",
    resolver: "mast-observation@1",
    observationId: "26442812",
  }], {
    fetchImpl: async (input, init) => {
      const method = init?.method ?? "GET";
      requests.push({ url: String(input), method, body: init?.body ? String(init.body) : undefined });
      if (method !== "POST") throw new Error("preview must not fetch a science product");
      return new Response(JSON.stringify({ status: "COMPLETE", Tables: [{
        Columns: ["obsid", "parent_obsid", "dataproduct_type", "productType", "dataRights", "productFilename", "dataURI", "dataSize"].map((dataIndex) => ({ dataIndex })),
        Rows: [
          [26442812, 26442812, "image", "SCIENCE", "PUBLIC", "j12345678_drz.fits", "mast:HST/product/j12345678_drz.fits", 100],
          [26442812, 26442812, "image", "CALIBRATION", "PUBLIC", "j12345678_dark.fits", "mast:HST/product/j12345678_dark.fits", 200],
          [26442812, 26442812, "image", "SCIENCE", "PUBLIC", "metadata.json", "mast:HST/product/metadata.json", 50],
          [26442812, 26442812, "image", "SCIENCE", "PROPRIETARY", "private.fits", "mast:HST/product/private.fits", 75],
          [26442812, 999, "image", "SCIENCE", "PUBLIC", "wrong-parent.fits", "mast:HST/product/wrong-parent.fits", 80],
          [999, 999, "image", "SCIENCE", "PUBLIC", "other-observation.fits", "mast:HST/product/other-observation.fits", 90],
        ],
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://mast.stsci.edu/api/v0/invoke");
  assert.equal(requests[0]?.method, "POST");
  const form = new URLSearchParams(requests[0]?.body);
  const envelope = JSON.parse(form.get("request") ?? "{}") as { service: string; params: { obsid: number }; format: string; pagesize: number; page: number };
  assert.equal(envelope.service, "Mast.Caom.Products");
  assert.equal(envelope.params.obsid, 26442812);
  assert.equal(envelope.format, "json");
  assert.equal(envelope.pagesize, 513);
  assert.equal(envelope.page, 1);
  assert.equal(inventory.files.length, 1);
  assert.equal(inventory.files[0]?.relativePath.endsWith("/j12345678_drz.fits"), true);
  assert.equal(inventory.files[0]?.sizeBytes, 100);
  const download = new URL(inventory.files[0]!.url);
  assert.equal(download.origin, "https://mast.stsci.edu");
  assert.equal(download.pathname, "/api/v0.1/Download/file");
  assert.equal(download.searchParams.get("uri"), "mast:HST/product/j12345678_drz.fits");
  assert.equal(inventory.units[0]?.resolver, "mast-observation@1");
  assert.equal(inventory.units[0]?.status, "resolved");
});

test("direct-file metadata rejects missing and listing responses but records unsupported HEAD as unverified", async () => {
  for (const response of [
    new Response(null, { status: 403 }),
    new Response(null, { status: 404 }),
    new Response(null, { status: 200, headers: { "content-type": "text/html" } }),
    new Response(null, { status: 200, headers: { "content-type": "application/json" } }),
  ]) {
    const inventory = await resolveSourceInventory([directFileUnit], { fetchImpl: async () => response });
    assert.equal(inventory.files.length, 0);
    assert.equal(inventory.units[0]?.status, "unavailable");
  }

  const unsupported = await resolveSourceInventory([directFileUnit], {
    fetchImpl: async () => new Response(null, { status: 405 }),
  });
  assert.equal(unsupported.files.length, 1);
  assert.equal(unsupported.files[0]?.metadataState, "unverified");
  assert.match(unsupported.units[0]?.note ?? "", /could not be verified/);

  const failedTransport = await resolveSourceInventory([directFileUnit], {
    fetchImpl: async () => { throw new Error("connection interrupted"); },
  });
  assert.equal(failedTransport.files[0]?.metadataState, "unverified");
  assert.match(failedTransport.units[0]?.note ?? "", /could not be verified/);

  const missingLength = await resolveSourceInventory([directFileUnit], {
    fetchImpl: async () => new Response(null, { status: 200, headers: { "content-type": "application/fits" } }),
  });
  assert.equal(missingLength.files[0]?.sizeBytes, undefined);
});
