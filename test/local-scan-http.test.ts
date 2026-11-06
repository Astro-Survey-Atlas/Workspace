import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { ASTRO_OBJECT_INDEX } from "../src/astro-object-index.js";
import { ASTRO_FILE_INDEX } from "../src/astro-index.js";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return address.port;
}
function matches(value: Record<string, unknown>, query: any): boolean {
  if (!query || query.match_all) return true;
  if (query.match_none) return false;
  if (query.ids) return query.ids.values.includes(value._id);
  if (query.term) return Object.entries(query.term).every(([key,item]) => value[key] === item);
  if (query.terms) return Object.entries(query.terms).every(([key,items]) => (items as unknown[]).includes(value[key]));
  if (query.range) return Object.entries(query.range).every(([key,range]) => {
    const r = range as {gte?:number;lte?:number};
    return (r.gte === undefined || Number(value[key]) >= r.gte) && (r.lte === undefined || Number(value[key]) <= r.lte);
  });
  if (query.bool) {
    const bool=query.bool;
    return (bool.filter ?? []).every((q: any) => matches(value,q))
      && (!bool.should || bool.should.filter((q:any) => matches(value,q)).length >= (bool.minimum_should_match ?? 1));
  }
  throw new Error(`Unsupported ES test query: ${JSON.stringify(query)}`);
}
async function until(check: () => Promise<boolean>, message: () => string, timeout=20000): Promise<void> {
  const deadline = Date.now()+timeout;
  while(Date.now()<deadline) { if(await check()) return; await new Promise(resolve=>setTimeout(resolve,50)); }
  assert.fail(message());
}
async function stop(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exit = new Promise<void>(resolve => child.once("exit",()=>resolve()));
  child.kill("SIGTERM"); await exit;
}

test("API and separate worker preserve publication across failure, retry, FITS tables and immutable S3 input", { timeout: 120000 }, async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"workspace-http-worker-"));
  const source=path.join(root,"input"), state=path.join(root,"state");
  await mkdir(source); await mkdir(state);
  const sourceCsv=path.join(source,"catalog.csv");
  await writeFile(sourceCsv,"id,ra,dec,flux\none,10.25,-1.5,42\ntwo,10.75,-1.25,84\n");
  const documents=new Map<string,Record<string,unknown>>();
  const requests: string[]=[];
  let failNextBulk = false;
  let bulkBarrier: { enter(): void; released: Promise<void> } | undefined;
  const es=createServer(async (request,response)=>{
    try {
      const route=new URL(request.url!,"http://test").pathname;
      requests.push(`${request.method} ${route}`);
      let text=""; for await(const chunk of request) text+=chunk;
      response.setHeader("Content-Type","application/json");
      if(request.method==="HEAD" || request.method==="PUT") { response.end("{}"); return; }
      if(route==="/_bulk") {
        if (bulkBarrier) {
          const barrier = bulkBarrier;
          bulkBarrier = undefined;
          barrier.enter();
          await barrier.released;
        }
        if (failNextBulk) {
          failNextBulk = false;
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "fixture index unavailable" }));
          return;
        }
        const lines=text.trim().split("\n");
        for(let i=0;i<lines.length;i+=2) {
          const action=JSON.parse(lines[i]!).index;
          documents.set(`${action._index}/${action._id}`,{...JSON.parse(lines[i+1]!),_id:action._id,_index:action._index});
        }
        response.end(JSON.stringify({errors:false,items:Array.from({length:lines.length/2},()=>({index:{status:201}}))}));return;
      }
      if(route.endsWith("/_refresh") || route.endsWith("/_mapping")) {response.end("{}");return;}
      if(route.endsWith("/_search")) {
        const body=JSON.parse(text),index=decodeURIComponent(route.split("/")[1]!);
        const found=[...documents.values()].filter(doc=>doc._index===index && matches(doc,body.query));
        const hits=found.slice(0,body.size ?? 10).map(doc=>({_id:doc._id,sort:[doc.healpix_pixel,doc.ra_deg,doc.dec_deg,doc.asset_id,doc.source_file_id,doc.object_id],_source:doc}));
        response.end(JSON.stringify({hits:{total:{value:found.length,relation:"eq"},hits}}));return;
      }
      response.statusCode=404; response.end("{}");
    } catch(error) {response.statusCode=500;response.end(JSON.stringify({error:String(error)}));}
  });
  const esPort=await listen(es),reserve=createServer(),port=await listen(reserve);
  await new Promise<void>(resolve=>reserve.close(()=>resolve()));
  const base=`http://127.0.0.1:${port}`;
  const environment={...process.env,PORT:String(port),HOST:"127.0.0.1",ASTRO_STATE_ROOT:state,
    ASTRO_SQLITE_PATH:path.join(state,"workspace.sqlite"),ASTRO_LOCAL_CONNECTOR_ROOTS:source,
    ASTRO_SCANS_PAUSED:"false",ASTRO_WORKSPACE_SCAN_ENABLED:"true",ASTRO_ES_URL:`http://127.0.0.1:${esPort}`,
    ASTRO_RESOURCE_CATALOG_URL:"file:///not-present/catalog.json",ASTRO_ALLOWED_HOSTS:"127.0.0.1,localhost",
    ASTRO_MOC_CORE_CLI:process.env.ASTRO_TEST_MOC_CORE_CLI ?? `${process.execPath} --import tsx ${path.resolve("test/helpers/mock-moc-core-cli.ts")}`,
    OTEL_EXPORTER_OTLP_ENDPOINT:"",ASTRO_VIEWER_ROOT:"/not-present/viewer"};
  let logs="",api:ChildProcess|undefined,worker:ChildProcess|undefined;
  const launch=(entry:string)=>{
    const child=spawn(process.execPath,["--import","tsx",entry],{env:environment,stdio:["ignore","pipe","pipe"]});
    child.stdout!.on("data",data=>{logs+=data;});child.stderr!.on("data",data=>{logs+=data;});return child;
  };
  const json=async (route:string,body?:unknown)=>{
    const response=await fetch(base+route,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await response.json() as any;assert.ok(response.ok,JSON.stringify(value));return value;
  };
  try {
    api=launch("src/http-server.ts");
    await until(async()=>{try{return(await fetch(base+"/healthz")).ok;}catch{return false;}},()=>logs);
    const {connector}=await json("/api/connectors",{name:"Local fixture",kind:"local",config:{rootPath:source}});
    await json(`/api/connectors/${connector.id}/check`,{});
    const {asset}=await json("/api/data-assets",{name:"Fixture catalog",kind:"catalog",product:"catalog",connector:"local",sourceUri:`local://${source}`,connectorIds:[connector.id],scanSpec:{format:"csv",objectIdColumn:"id",raColumn:"ra",decColumn:"dec",coordinateFrame:"ICRS",coordinateUnits:"deg"}});
    // A missing selected file is accepted while the API only persists the command.
    const queued=await json(`/api/data-assets/${asset.id}/scan-runs`,{relativePath:"not-there.csv"});
    assert.equal(queued.run.status,"queued");assert.equal(requests.length,0,"Submission cannot contact ES or enumerate input");
    await json(`/api/connectors/${connector.id}/ingest-runs/${queued.run.id}/cancel`,{});
    const {run}=await json(`/api/data-assets/${asset.id}/scan-runs`,{relativePath:"catalog.csv"});
    assert.equal(run.status,"queued");assert.equal(run.scanTask,undefined,"Internal checkpoint must not enter the public response");
    await json("/api/scanning/pause",{});
    worker=launch("src/scan-worker.ts");
    await until(async()=>logs.includes("scan worker ready"),()=>logs);
    assert.equal(documents.size,0,"Paused worker must not read sources");
    await json("/api/scanning/resume",{});
    let completed:any;
    await until(async()=>{completed=(await json(`/api/connectors/${connector.id}/ingest-runs`)).runs.find((r:any)=>r.id===run.id);return ["succeeded","failed"].includes(completed?.status);},()=>logs);
    assert.equal(completed.status,"succeeded",completed.error+logs);
    assert.equal(completed.pointCount,2);assert.equal(completed.processedFiles,1);
    const positions=[...documents.values()].filter(doc=>doc._index===ASTRO_OBJECT_INDEX);
    assert.equal(positions.length,2);
    assert.ok(positions.every(doc=>!(doc.attributes as any).flux && doc.evidence_ref));
    const files=[...documents.values()].filter(doc=>doc._index===ASTRO_FILE_INDEX);
    assert.equal(files.length,1);assert.equal(files[0]!.size_bytes,Buffer.byteLength(await readFile(sourceCsv)));
    const coverage=await json(`/api/sky/coverage?nside=16&assetIds=${asset.id}`);
    assert.equal(coverage.status,"ready");assert.ok(coverage.pixels.length>0);
    const result=await json("/api/sky/points/query",{bbox:{raMin:9,raMax:12,decMin:-3,decMax:0},region:{nside:16,pixels:coverage.pixels,coordinateFrame:"ICRS",ordering:"NESTED"},layerScopes:[{assetId:asset.id}],limit:2000});
    assert.equal(result.objects.length,2);assert.equal(result.objects[0].attributes.flux,undefined);
    const detail=await json(`/api/sky/points/${positions[0]!._id}`);
    assert.equal(detail.point.attributes.flux,"42");

    const entryRegion = { nside: 1, pixels: Array.from({ length: 12 }, (_, index) => index), coordinateFrame: "ICRS", ordering: "NESTED" };
    // An unpublished failed generation cannot replace the currently visible one.
    failNextBulk = true;
    const failedSubmission = await json(`/api/data-assets/${asset.id}/scan-runs`, { relativePath: "catalog.csv" });
    await until(async () => {
      const current = (await json(`/api/connectors/${connector.id}/ingest-runs`)).runs.find((r:any) => r.id === failedSubmission.run.id);
      return current?.status === "failed";
    }, () => logs);
    const unchanged = await json("/api/sky/points/query", { region: entryRegion, bbox: { raMin: 9, raMax: 12, decMin: -3, decMax: 0 }, layerScopes: [{ assetId: asset.id }] });
    assert.deepEqual(unchanged.objects.map((p:any) => p.id), result.objects.map((p:any) => p.id));
    assert.deepEqual((await json(`/api/sky/coverage?nside=16&assetIds=${asset.id}`)).pixels, coverage.pixels);
    await json(`/api/connectors/${connector.id}/ingest-runs/${failedSubmission.run.id}/retry`, {});
    await until(async () => (await json(`/api/connectors/${connector.id}/ingest-runs`)).runs.some((r:any) => r.id === failedSubmission.run.id && r.status === "succeeded"), () => logs);
    const replaced = await json("/api/sky/points/query", { region: entryRegion, bbox: { raMin: 9, raMax: 12, decMin: -3, decMax: 0 }, layerScopes: [{ assetId: asset.id }] });
    assert.equal(replaced.objects.length, 2, "Only the committed generation is visible after retry");
    assert.ok(replaced.objects.every((p:any) => !positions.some(old => old._id === p.id)));

    // Pause during a write, restart, and explicitly resume the uncommitted batch.
    let writing = false;
    let releaseBulk = () => {};
    bulkBarrier = { enter: () => { writing = true; }, released: new Promise<void>(resolve => { releaseBulk = resolve; }) };
    const interrupted = (await json(`/api/data-assets/${asset.id}/scan-runs`, { relativePath: "catalog.csv" })).run;
    await until(async () => writing, () => logs);
    await json(`/api/connectors/${connector.id}/ingest-runs/${interrupted.id}/pause`, {});
    releaseBulk();
    await stop(worker);
    worker = undefined;
    const pausedRun = (await json(`/api/connectors/${connector.id}/ingest-runs`)).runs.find((r:any) => r.id === interrupted.id);
    assert.equal(pausedRun.status, "paused");
    const whilePaused = await json("/api/sky/points/query", { region: entryRegion, bbox: { raMin: 9, raMax: 12, decMin: -3, decMax: 0 }, layerScopes: [{ assetId: asset.id }] });
    assert.deepEqual(whilePaused.objects.map((p:any) => p.id), replaced.objects.map((p:any) => p.id));
    worker = launch("src/scan-worker.ts");
    await json(`/api/connectors/${connector.id}/ingest-runs/${interrupted.id}/resume`, {});
    await until(async () => (await json(`/api/connectors/${connector.id}/ingest-runs`)).runs.some((r:any) => r.id === interrupted.id && r.status === "succeeded"), () => logs);

    // FITS tables use exactly the same catalog/index/publication path as CSV.
    await promisify(execFile)(process.env.ASTRO_PYTHON ?? "python3", ["-c", "from astropy.io import fits; import sys; fits.BinTableHDU.from_columns([fits.Column(name='SOURCE',format='8A',array=['f1']),fits.Column(name='RA',format='D',array=[10.5]),fits.Column(name='DEC',format='D',array=[-1.4]),fits.Column(name='FLUX',format='D',array=[21.0])]).writeto(sys.argv[1])", path.join(source, "table.fits")]);
    const fitsAsset = (await json("/api/data-assets", { name: "FITS fixture", kind: "catalog", product: "catalog", connector: "local", sourceUri: `local://${source}`, connectorIds: [connector.id], scanSpec: { format: "fits", objectIdColumn: "SOURCE", raColumn: "RA", decColumn: "DEC" } })).asset;
    const fitsRun = (await json(`/api/data-assets/${fitsAsset.id}/scan-runs`, { relativePath: "table.fits" })).run;
    await until(async () => {
      const current = (await json(`/api/connectors/${connector.id}/ingest-runs`)).runs.find((r:any) => r.id === fitsRun.id);
      if (current?.status === "failed") assert.fail(current.error + logs);
      return current?.status === "succeeded";
    }, () => logs);
    const fitsPoints = await json("/api/sky/points/query", { region: entryRegion, bbox: { raMin: 9, raMax: 12, decMin: -3, decMax: 0 }, layerScopes: [{ assetId: fitsAsset.id }] });
    assert.equal(fitsPoints.objects.length, 1);
    assert.equal((await json(`/api/sky/points/${fitsPoints.objects[0].id}`)).point.attributes.FLUX, "21.0");

    const images = path.join(source, "images");
    await mkdir(images);
    await promisify(execFile)("python3", ["-c", `
from astropy.io import fits
import numpy as np, pathlib, sys
root=pathlib.Path(sys.argv[1])
header=fits.Header({"CRPIX1":10.5,"CRPIX2":10.5,"CRVAL1":12.5,"CRVAL2":-3.25,
 "CTYPE1":"RA---TAN","CTYPE2":"DEC--TAN","CDELT1":-0.001,"CDELT2":0.001,
 "PIXSCAL1":3.6,"PIXSCAL2":3.6,"RADESYS":"ICRS"})
fits.PrimaryHDU(np.zeros((20,20),dtype=np.float32),header).writeto(root/"good.fits")
header["PIXSCAL2"]=3.5
fits.PrimaryHDU(np.zeros((20,20),dtype=np.float32),header).writeto(root/"bad.fits")
`, images]);
    const imageAsset = (await json("/api/data-assets", { name: "Quality-controlled images", kind: "image", product: "imaging",
      connector: "local", sourceUri: `local://${images}`, connectorIds: [connector.id],
      scanSpec: { format: "fits", fitsQualityProfile: "csst-wcs-v1" } })).asset;
    const imageRun = (await json(`/api/data-assets/${imageAsset.id}/scan-runs`, { relativePath: "images" })).run;
    let imageResult: any;
    await until(async () => {
      imageResult = (await json(`/api/connectors/${connector.id}/ingest-runs`)).runs.find((r:any) => r.id === imageRun.id);
      if (imageResult?.status === "failed") assert.fail(imageResult.error + logs);
      return imageResult?.status === "succeeded";
    }, () => logs);
    assert.equal(imageResult.acceptedFileCount, 1);
    assert.equal(imageResult.skippedFileCount, 1);
    assert.equal(imageResult.failedFiles, 0);
    const imageCoverage = await json(`/api/sky/coverage?nside=16&assetIds=${imageAsset.id}`);
    assert.equal(imageCoverage.layers[0].coverageRole, "object_presence");
    const imagePoints = await json("/api/sky/points/query", { region: entryRegion,
      bbox: { raMin: 12, raMax: 13, decMin: -4, decMax: -3 }, layerScopes: [{ assetId: imageAsset.id }] });
    assert.equal(imagePoints.objects.length, 1);
    const imageDetail = await json(`/api/sky/points/${imagePoints.objects[0].id}`);
    assert.equal(imageDetail.point.attributes.file_name, "good.fits");
    assert.ok(imageDetail.point.attributes.header.includes("PIXSCAL1"));
    assert.equal([...documents.values()].filter(doc => doc.asset_id === imageAsset.id && doc._index === ASTRO_FILE_INDEX).length, 1);
    const badImageRun = (await json(`/api/data-assets/${imageAsset.id}/scan-runs`, { relativePath: "images/bad.fits" })).run;
    await until(async () => (await json(`/api/connectors/${connector.id}/ingest-runs`)).runs.some((r:any) => r.id === badImageRun.id && r.status === "failed"), () => logs);
    assert.equal((await json(`/api/data-assets/${imageAsset.id}`)).asset.activeScan.runId, imageRun.id);

    const remoteCsv = "id,ra,dec,flux\ns3-one,10.6,-1.3,63\n";
    let objectReads = 0;
    const s3 = createServer((request, response) => {
      const url = new URL(request.url!, "http://fixture");
      if (request.method === "HEAD") { response.end(); return; }
      if (url.searchParams.has("list-type")) {
        response.setHeader("Content-Type", "application/xml");
        response.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>fixture</Name><IsTruncated>false</IsTruncated><Contents><Key>catalog.csv</Key><Size>${Buffer.byteLength(remoteCsv)}</Size><ETag>"fixture-version-1"</ETag></Contents></ListBucketResult>`);
        return;
      }
      assert.equal(request.headers["if-match"], '"fixture-version-1"');
      objectReads++;
      response.writeHead(200, { "Content-Type": "text/csv", "Content-Length": Buffer.byteLength(remoteCsv), ETag: '"fixture-version-1"' });
      response.end(remoteCsv);
    });
    const s3Port = await listen(s3);
    try {
      const remote = (await json("/api/connectors", { name: "S3 fixture", kind: "s3", config: { endpoint: `http://127.0.0.1:${s3Port}`, bucket: "fixture", region: "us-east-1" }, credentials: { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" } })).connector;
      await json(`/api/connectors/${remote.id}/check`, {});
      const remoteAsset = (await json("/api/data-assets", { name: "S3 catalog", kind: "catalog", product: "catalog", connector: "s3", sourceUri: "s3://fixture/catalog.csv", connectorIds: [remote.id], scanSpec: { format: "csv", objectIdColumn: "id", raColumn: "ra", decColumn: "dec", coordinateFrame: "ICRS", coordinateUnits: "deg" } })).asset;
      const remoteRun = (await json(`/api/data-assets/${remoteAsset.id}/scan-runs`, { relativePath: "catalog.csv" })).run;
      await until(async () => {
        const current = (await json(`/api/connectors/${remote.id}/ingest-runs`)).runs.find((r:any) => r.id === remoteRun.id);
        if (current?.status === "failed") assert.fail(current.error + logs);
        return current?.status === "succeeded";
      }, () => logs);
      assert.equal(objectReads, 1);
      const remotePoints = await json("/api/sky/points/query", { region: entryRegion, bbox: { raMin: 9, raMax: 12, decMin: -3, decMax: 0 }, layerScopes: [{ assetId: remoteAsset.id }] });
      assert.equal(remotePoints.objects.length, 1);
      assert.equal((await json(`/api/sky/points/${remotePoints.objects[0].id}`)).point.attributes.flux, "63");
    } finally {
      s3.closeAllConnections();
      await new Promise<void>(resolve => s3.close(() => resolve()));
    }
    await json("/api/scanning/pause",{});
    const rejected=await fetch(base+`/api/data-assets/${asset.id}/scan-runs`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    assert.equal(rejected.status,409);
    await stop(worker);worker=undefined;await stop(api);api=undefined;
    const db=new DatabaseSync(path.join(state,"workspace.sqlite"));
    assert.equal(JSON.parse(String(db.prepare("SELECT record FROM workspace_state WHERE namespace='scanning'").get()!.record)).paused,true);
    assert.equal(db.prepare("SELECT count(*) AS n FROM data_assets WHERE json_extract(record,'$.activeScan.runId')=?").get(interrupted.id)!.n,1);db.close();
  } finally {await stop(worker);await stop(api);es.closeAllConnections();await new Promise<void>(resolve=>es.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
