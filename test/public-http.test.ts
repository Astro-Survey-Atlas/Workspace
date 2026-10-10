import assert from "node:assert/strict";
import test from "node:test";
import { fetchPublicHttp } from "../src/public-http.js";

test("archive redirects validate every destination and do not forward credentials across hosts", async () => {
  const calls: string[] = [];
  const result = await fetchPublicHttp("https://archive.test/file", { headers: { Authorization: "secret", "X-Assets-API-Key": "key" } }, {
    skipDnsLookup: true,
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "https://delivery.test/data.fits" } });
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      assert.equal(new Headers(init?.headers).has("X-Assets-API-Key"), false);
      return new Response("science bytes");
    },
  });
  assert.equal(await result.text(), "science bytes");
  assert.equal(calls.length, 2);
});

test("an archive redirect cannot send a download into a private network", async () => {
  let calls = 0;
  await assert.rejects(() => fetchPublicHttp("https://archive.test/file", {}, {
    skipDnsLookup: true,
    fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }); },
  }), /private network/);
  assert.equal(calls, 1);
});

test("cancelling during DNS stops the wait and never issues the outbound request", async () => {
  const controller = new AbortController();
  let releaseDns: ((addresses: string[]) => void) | undefined;
  let requested = 0;
  const pending = fetchPublicHttp("https://archive.test/file", { signal: controller.signal }, {
    resolveHostname: () => new Promise((resolve) => { releaseDns = resolve; }),
    fetchImpl: async () => { requested++; return new Response(null); },
  });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  releaseDns?.(["8.8.8.8"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requested, 0);
});
