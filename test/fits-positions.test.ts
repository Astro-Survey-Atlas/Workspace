import assert from "node:assert/strict";
import test from "node:test";
import { convertPositionHeaders, imagePointsContainingCoordinate, pointDocument } from "../src/fits-positions.js";
import { ASTRO_OBJECT_INDEX as SKY_DATA_POINT_INDEX } from "../src/astro-object-index.js";
import type { ConnectorIngestRunRecord } from "../src/connector-history.js";
function header(values: Record<string, unknown>): string {
  return [...Object.entries(values).map(([key, value]) => `${key.padEnd(8)}= ${typeof value === "string" ? `'${value}'` : String(value)}`.padEnd(80)), "END".padEnd(80)].join("").padEnd(2880);
}
test("CSST quality profile rejects missing nominal scales and scale drift before indexing", async () => {
  const values = { SIMPLE: true, NAXIS: 2, NAXIS1: 100, NAXIS2: 100, CRPIX1: 50.5, CRPIX2: 50.5,
    CRVAL1: 12.5, CRVAL2: -3.25, CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN", CDELT1: -0.001, CDELT2: 0.001 };
  const convert = (extra: Record<string, unknown>) => convertPositionHeaders([{ file_id: "quality", source_uri: "local:///fixture.fits", file_name: "fixture.fits", hdu_index: 0,
    quality_profile: "csst-wcs-v1", header: header({ ...values, ...extra }) }]);
  const accepted = await convert({ PIXSCAL1: 3.6, PIXSCAL2: 3.6 });
  assert.equal(accepted[0]?.position_role, "image_center");
  assert.ok((await convert({})).some(point => String(point.error).includes("PIXSCAL")));
  assert.ok((await convert({ PIXSCAL1: 3.6, PIXSCAL2: 3.5 })).some(point => String(point.error).includes("tolerance")));
});
test("multiple science HDUs produce ICRS image centers, exclude DQ, preserve inherited frame", async () => {
  const primary = header({ SIMPLE: true, NAXIS: 0, RADESYS: "ICRS" });
  const science = { XTENSION: "IMAGE", NAXIS: 2, NAXIS1: 100, NAXIS2: 100, CRPIX1: 50.5, CRPIX2: 50.5,
    CRVAL1: 12.5, CRVAL2: -3.25, CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN", CDELT1: -0.001, CDELT2: 0.001 };
  const records = [{ file_id: "one", source_uri: "file:///data/science.fits", file_name: "science.fits", hdu_index: 0, header: primary, primary_header: primary },
    ...[1, 2, 4].map((hdu_index) => ({ file_id: "one", source_uri: "file:///data/science.fits", file_name: "science.fits", hdu_index, primary_header: primary,
      header_scope: "through_selected_hdu", selected_hdu_index: 4,
      header: header({ ...science, EXTNAME: hdu_index === 2 ? "DQ" : "SCI", CRVAL1: hdu_index === 4 ? 13 : 12.5 }) }))];
  const points = await convertPositionHeaders(records);
  assert.deepEqual(points.map((row) => row.hdu_index), [1, 4]);
  assert.equal(points[0]?.position_role, "image_center"); assert.ok(Math.abs(Number(points[0]?.ra_deg) - 12.5) < 1e-8);
  assert.ok(Math.abs(Number(points[1]?.ra_deg) - 13) < 1e-8);
  const document = pointDocument(points[0] as Parameters<typeof pointDocument>[0], { id: "asset", surveyId: "hst" }, { id: "scan", sourceSnapshotSha256: "a".repeat(64) } as ConnectorIngestRunRecord);
  assert.equal(document._index, SKY_DATA_POINT_INDEX); assert.equal(document.attributes.hdu_index, "1");
  assert.equal(document.attributes.header_scope, "through_selected_hdu"); assert.equal(document.attributes.selected_hdu_index, "4");
  assert.deepEqual(pointDocument(points[0] as Parameters<typeof pointDocument>[0], { id: "asset", surveyId: "hst" }, { id: "scan", sourceSnapshotSha256: "a".repeat(64) } as ConnectorIngestRunRecord), document);
});
test("missing coordinates remain evidence errors instead of manufactured HEALPix centers", async () => {
  const result = await convertPositionHeaders([{ file_id: "empty", hdu_index: 0, header: header({ SIMPLE: true, NAXIS: 0 }) }]);
  assert.equal(result.length, 1); assert.match(String(result[0]?.error), /no usable/); assert.equal(result[0]?.ra_deg, undefined);
});
test("WCS image containment handles coordinates across the RA zero boundary", async () => {
  const imageHeader = header({ XTENSION: "IMAGE", NAXIS: 2, NAXIS1: 100, NAXIS2: 100,
    CRPIX1: 50.5, CRPIX2: 50.5, CRVAL1: 359.99, CRVAL2: 10,
    CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN", CDELT1: -0.001, CDELT2: 0.001 });
  const points = [{ object_id: "ra-wrap-image", ra_deg: 359.99, dec_deg: 10, survey: "test", release: "r1",
    product: "image", modality: "image", asset_id: "asset", attributes: {
      position_role: "image_center", hdu_index: "1", header: imageHeader,
    } }];

  const inside = await imagePointsContainingCoordinate(points, 0.01, 10);
  const outside = await imagePointsContainingCoordinate(points, 359.9, 10);
  assert.deepEqual(inside.map((point) => point.object_id), ["ra-wrap-image"]);
  assert.deepEqual(outside, []);
});
test("FK5 image boundaries convert to ICRS and cube dimensions follow the celestial sub-WCS", async () => {
  const fk5Header = header({ XTENSION: "IMAGE", BITPIX: -32, NAXIS: 2, NAXIS1: 100, NAXIS2: 100,
    CRPIX1: 50.5, CRPIX2: 50.5, CRVAL1: 180, CRVAL2: 20,
    CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN", CDELT1: -0.001, CDELT2: 0.001,
    RADESYS: "FK5", EQUINOX: 1975 });
  const [fk5] = await convertPositionHeaders([{ file_id: "fk5", source_uri: "file:///data/fk5.fits",
    file_name: "fk5.fits", hdu_index: 1, header: fk5Header }]);
  assert.ok(fk5 && !fk5.error);
  assert.ok(Math.abs(Number(fk5.ra_deg) - 180.320118924502) < 1e-9);
  assert.ok(Math.abs(Number(fk5.dec_deg) - 19.860815776715) < 1e-9);
  const corners = [[180.372733287647, 19.811308439866], [180.267505313847, 19.811307732354],
    [180.267471712306, 19.910307665733], [180.372765384209, 19.910308373686]];
  const boxes = fk5.footprint_bounds as number[][];
  for (const [ra, dec] of corners) {
    assert.ok(boxes.some(([raMin, raMax, decMin, decMax]) => ra! >= raMin! && ra! <= raMax!
      && dec! >= decMin! && dec! <= decMax!), `FK5 corner ${ra},${dec} is outside the ICRS bounds`);
  }

  const cubeHeader = header({ XTENSION: "IMAGE", BITPIX: -32, NAXIS: 3, NAXIS1: 2, NAXIS2: 100, NAXIS3: 200,
    CTYPE1: "FREQ", CTYPE2: "RA---TAN", CTYPE3: "DEC--TAN", CUNIT1: "Hz",
    CRPIX1: 1, CRPIX2: 50, CRPIX3: 100, CRVAL1: 1.4e9, CRVAL2: 180, CRVAL3: 20,
    CDELT1: 1e6, CDELT2: -0.01, CDELT3: 0.01, RADESYS: "ICRS" });
  const [cube] = await convertPositionHeaders([{ file_id: "cube", source_uri: "file:///data/cube.fits",
    file_name: "cube.fits", hdu_index: 0, header: cubeHeader }]);
  assert.ok(cube && !cube.error);
  assert.equal((cube.moc_header as Record<string, unknown>).NAXIS, 2);
  assert.equal((cube.moc_header as Record<string, unknown>).NAXIS1, 100);
  assert.equal((cube.moc_header as Record<string, unknown>).NAXIS2, 200);
  const points = [{ object_id: "cube-image", ra_deg: Number(cube.ra_deg), dec_deg: Number(cube.dec_deg), survey: "test",
    release: "r1", product: "image", modality: "image", asset_id: "asset",
    attributes: { position_role: "image_center", hdu_index: "0", header: cubeHeader } }];
  const inside = await imagePointsContainingCoordinate(points, Number(cube.ra_deg), Number(cube.dec_deg));
  assert.deepEqual(inside.map((point) => point.object_id), ["cube-image"]);
});
