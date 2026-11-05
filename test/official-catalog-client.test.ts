import assert from "node:assert/strict";
import test from "node:test";

import { OfficialArchiveCatalogQueryClient, buildOfficialCatalogAdql } from "../src/official-catalog-client.js";
import { DESI_CATALOG, EUCLID_CATALOG } from "../src/scientific-tools.js";

function queryContext(catalog: string, values: Partial<{
  raDeg: number;
  decDeg: number;
  radiusArcsec: number;
  limit: number;
  fields: Record<string, string>;
}> = {}) {
  return {
    catalog,
    raDeg: values.raDeg ?? 58.375,
    decDeg: values.decDeg ?? -51.25,
    radiusArcsec: values.radiusArcsec ?? 250,
    limit: values.limit ?? 500,
    ...(values.fields ? { fields: values.fields } : {}),
  };
}

function csvFetch(csv: string, onRequest?: (url: string, init: RequestInit | undefined) => void): typeof fetch {
  return async (input, init) => {
    onRequest?.(String(input), init);
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8" } });
  };
}

test("builds bounded ADQL with RA wrap and a safe projected-column list", () => {
  const adql = buildOfficialCatalogAdql(queryContext(EUCLID_CATALOG, {
    raDeg: 359.99,
    decDeg: 0,
    limit: 500,
    fields: { redshift: "z_phot" },
  }));

  assert.match(adql, /^SELECT TOP 501 /);
  assert.match(adql, /z_phot/);
  assert.match(adql, /\(right_ascension >= .* OR right_ascension <= .*\)/);
  assert.doesNotMatch(adql, /POINT\(|CIRCLE\(/);
  assert.throws(() => buildOfficialCatalogAdql(queryContext(DESI_CATALOG, {
    fields: { redshift: "flux_r; DROP TABLE tractor" },
  })), /simple catalog column identifier/);
});

test("omits RA bounds for a cone that crosses a pole", () => {
  const adql = buildOfficialCatalogAdql(queryContext(DESI_CATALOG, {
    raDeg: 42,
    decDeg: 89.5,
    radiusArcsec: 3_600,
  }));
  const where = adql.slice(adql.indexOf(" WHERE "));
  assert.match(where, /dec >= 88\.5/);
  assert.match(where, /brick_primary = 1/);
  assert.doesNotMatch(where, /\bra\s*[<>=]/);
});

test("preserves Euclid long IDs, derives tile index, and maps selected columns", async () => {
  let requestUrl = "";
  let requestForm: URLSearchParams | undefined;
  const fetchImpl = csvFetch(
    "object_id,right_ascension,declination,segmentation_map_id,extended_flag,z_phot\n"
      + "-584636582512916265,58.463658214033686,-51.29162657186233,102018212030287,,0.42\n",
    (url, init) => {
      requestUrl = url;
      const body = init?.body;
      requestForm = body instanceof URLSearchParams ? body : new URLSearchParams(String(body ?? ""));
    },
  );
  const client = new OfficialArchiveCatalogQueryClient(5_000, fetchImpl, "https://esa.example/tap", "https://datalab.example/tap");
  const result = await client.query({}, queryContext(EUCLID_CATALOG, { fields: { redshift: "z_phot" } })) as {
    hits: Array<Record<string, unknown>>;
    backend: { provider: string; release: string; table: string };
    queryLimit: number;
    truncated: boolean;
  };

  assert.equal(requestUrl, "https://esa.example/tap/sync");
  assert.equal(requestForm?.get("REQUEST"), "doQuery");
  assert.equal(requestForm?.get("MAXREC"), "501");
  assert.equal(result.hits[0]?.object_id, "-584636582512916265");
  assert.equal(result.hits[0]?.TILE_INDEX, "102018212");
  assert.deepEqual(result.hits[0]?.asa_catalog_fields, { redshift: "0.42" });
  assert.deepEqual(result.backend, { provider: "esa-tap", release: "euclid-q1-mer", table: "catalogue.mer_catalogue" });
  assert.equal(result.queryLimit, 500);
  assert.equal(result.truncated, false);
});

test("maps DESI stable and brick IDs and marks rows beyond the requested limit", async () => {
  let requestForm: URLSearchParams | undefined;
  const csv = [
    "ls_id,ra,dec,release,brickid,brickname,objid,brick_primary,type,flux_r",
    "10995192752508070,58.26470184240689,-51.26449773152549,10000,72932,0583m512,3238,1,PSF,0.053103026",
    "10995192752508075,58.2650058756382,-51.25729005175426,10000,72932,0583m512,3243,1,PSF,0.13959238",
  ].join("\n") + "\n";
  const client = new OfficialArchiveCatalogQueryClient(5_000, csvFetch(csv, (_url, init) => {
    const body = init?.body;
    requestForm = body instanceof URLSearchParams ? body : new URLSearchParams(String(body ?? ""));
  }), "https://esa.example/tap", "https://datalab.example/tap");
  const result = await client.query({}, queryContext(DESI_CATALOG, { limit: 1 })) as {
    hits: Array<Record<string, unknown>>;
    queryLimit: number;
    truncated: boolean;
  };

  assert.equal(requestForm?.get("MAXREC"), "2");
  assert.match(requestForm?.get("QUERY") ?? "", /brick_primary = 1/);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]?.TARGETID, "10995192752508070");
  assert.equal(result.hits[0]?.release, "10000");
  assert.equal(result.hits[0]?.brickid, "72932");
  assert.equal(result.hits[0]?.brickname, "0583m512");
  assert.equal(result.hits[0]?.objid, "3238");
  assert.ok(Number(result.hits[0]?.MAG_R) > 0);
  assert.equal(result.queryLimit, 1);
  assert.equal(result.truncated, true);
});

test("rejects TAP error documents returned with HTTP 200", async () => {
  const fetchImpl: typeof fetch = async () => new Response("<VOTABLE><INFO value=\"ERROR\"/></VOTABLE>", {
    headers: { "Content-Type": "application/x-votable+xml" },
  });
  const client = new OfficialArchiveCatalogQueryClient(5_000, fetchImpl, "https://esa.example/tap", "https://datalab.example/tap");
  await assert.rejects(client.query({}, queryContext(EUCLID_CATALOG)), /non-CSV response/);
});
