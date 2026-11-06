/** Offline conversion. Run only against a copied, stopped Workspace state volume. */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SqliteMetadataStore } from "../src/storage/sqlite.js";
import { LocalState } from "../src/local-state.js";
import { ConnectorIngestRunCatalog } from "../src/connector-history.js";
import { UserMocArtifactStore } from "../src/user-moc-artifacts.js";
import { MocCoreCliAdapter } from "../src/moc-core-adapter.js";
import { SurveyDirectory } from "../src/survey-directory.js";

function option(name: string): string {
  const value=process.argv[process.argv.indexOf(name)+1];
  if(!process.argv.includes(name) || !value) throw new Error(`${name} is required`);
  return path.resolve(value);
}
const root=option("--root"), receiptPath=option("--search-receipt");
const receipt=JSON.parse(await readFile(receiptPath,"utf8")) as {version:string;assets:Record<string,{pointCount:number;fileCount:number;pointCoverageRef:string}>};
const store=new SqliteMetadataStore(path.join(root,"workspace.sqlite"));
const state=new LocalState(store.filename);
const artifacts=new UserMocArtifactStore({root:path.join(root,"user-mocs")});
const runs=new ConnectorIngestRunCatalog(store);
const core=new MocCoreCliAdapter();
const counts:Record<string,number>={};
async function json(filename:string):Promise<any> {
  try{return JSON.parse(await readFile(filename,"utf8"));}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}
}
function importRecord(namespace:string,record:any):void {
  if(!record?.id)throw new Error(`Invalid ${namespace} record`);
  // Artifact paths are absolute container paths. Preserve /state references;
  // this tool never rebases them onto its private staging directory.
  state.put(namespace,record.id,record);counts[namespace]=(counts[namespace]??0)+1;
}
try {
  await store.initialize();await state.initialize();
  await new SurveyDirectory(store).importLegacy(path.join(root,"survey-registrations.json"));
  for(const entry of await readdir(path.join(root,"workflow-runs"),{withFileTypes:true}).catch(()=>[])) {
    if(entry.isFile()&&entry.name.endsWith(".json"))importRecord("workflow-runs",await json(path.join(root,"workflow-runs",entry.name)));
  }
  const sessions=path.join(root,"workflow-runs","_agent-sessions");
  const walk=async(directory:string):Promise<void>=>{
    for(const entry of await readdir(directory,{withFileTypes:true}).catch(()=>[])) {
      const filename=path.join(directory,entry.name);
      if(entry.isDirectory())await walk(filename);
      else if(entry.isFile()&&entry.name.endsWith(".json")) {
        const record=await json(filename);if(record?.id&&Array.isArray(record.messages))importRecord("workflow-sessions",record);
      }
    }
  };
  await walk(sessions);
  const agents=await json(path.join(root,"agent","workspace-agent-sessions.json"));
  for(const entry of agents?.sessions??[])importRecord("workspace-agent-sessions",entry);
  const production=await json(path.join(root,"production","production-runs.json"));
  for(const entry of (Array.isArray(production)?production:production?.runs??[])) {
    const record=structuredClone(entry);
    for(const step of record.steps??[])if(step.id==="warehouse")step.id="scan";
    if(record.input?.scanExecutor==="warehouse")record.input.scanExecutor="workspace";
    importRecord("production-runs",record);
  }
  state.put("scanning","control",{paused:true,updatedAt:new Date().toISOString(),reason:"轻量化重构后保持暂停；需要手动恢复"});
  for(const run of await runs.list())if(["queued","running"].includes(run.status)) {
    await runs.update(run.id,{status:"paused",error:"重构迁移时暂停；旧执行记录保留，请从资产提交新的本地扫描"});
    counts.pausedScans=(counts.pausedScans??0)+1;
  }
  const allAssets=await store.listDataAssets();
  for(const asset of allAssets) {
    const old=asset as unknown as Record<string,any>;
    if(old.warehouseScanSpec) {
      asset.scanSpec??={format:"fits",fileNamePattern:old.warehouseScanSpec.fileNamePattern,fitsQualityProfile:old.warehouseScanSpec.fitsQualityProfile};
      delete old.warehouseScanSpec;
    }
    const summary=receipt.assets[asset.id];
    if(summary?.pointCount) {
      const cells=await json(path.join(root,"workspace-scans",summary.pointCoverageRef)) as number[];
      if(!cells?.length)throw new Error(`Published positions have no point coverage: ${asset.id}`);
      const layerId=`workspace-${asset.id}`;
      const context={layerId,scanRunId:receipt.version,availableOrders:[8],maxOrder:8,precision:"estimated" as const,coverageRole:"object_presence" as const};
      const moc=await core.buildNestedHealpix({...context,cells:cells.map(ipix=>({order:8,ipix})),dataOrigin:"catalog",sourceTier:"user_file_derived"});
      const artifact=await artifacts.persist(moc,context,{statistics:{pointCount:summary.pointCount,fileCount:summary.fileCount},provenance:{kind:"validated_index_migration",scientificMeaning:"Cells containing real indexed positions; image extents remain in original MOC artifacts and footprint index",sourceVersion:receipt.version}});
      if(artifact.status!=="ready")throw new Error(artifact.error??"Migrated coverage failed validation");
      asset.activeScan={runId:receipt.version,dataBatchId:receipt.version,artifactId:artifact.id,pointCoverageRef:summary.pointCoverageRef,pointCount:summary.pointCount,fileCount:summary.fileCount,activatedAt:new Date().toISOString()};
      counts.publishedAssets=(counts.publishedAssets??0)+1;
    }
    await store.putDataAsset(asset);
  }
  await writeFile(path.join(root,"lightweight-migration-receipt.json"),JSON.stringify({searchVersion:receipt.version,counts,completedAt:new Date().toISOString()},null,2));
  console.info(JSON.stringify({complete:true,counts}));
} finally {state.close();await store.close();}
