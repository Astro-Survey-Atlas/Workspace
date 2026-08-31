import assert from "node:assert/strict";
import test from "node:test";

import { assertPublicHttpUrl, isNonPublicAddress } from "../src/remote-url-policy.js";

test("classifies loopback, private, link-local, and reserved addresses as non-public", () => {
  for (const address of ["127.0.0.1", "10.2.3.4", "172.20.0.4", "192.168.1.7", "169.254.10.2", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isNonPublicAddress(address), true, address);
  }
  assert.equal(isNonPublicAddress("8.8.8.8"), false);
});

test("rejects local URL literals and DNS results", async () => {
  await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1/catalog.fits", { skipDnsLookup: true }), /local or private/);
  await assert.rejects(() => assertPublicHttpUrl("https://catalog.example/catalog.fits", {
    resolveHostname: async () => ["192.168.10.20"],
  }), /resolves to a local or private/);
});

test("accepts an explicitly public DNS result", async () => {
  const url = await assertPublicHttpUrl("https://catalog.example/catalog.fits", {
    resolveHostname: async () => ["203.0.114.20"],
  });
  assert.equal(url.href, "https://catalog.example/catalog.fits");
});
