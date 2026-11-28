#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const core=readFileSync(resolve(root,'js/120-app-core.js'),'utf8');
const bridgeBackground=readFileSync(resolve(root,'extension/background.js'),'utf8');
const onholdHistory=readFileSync(resolve(root,'js/580-actual-scanned-onhold-history.js'),'utf8');
function extract(startMarker,endMarker){
  const start=core.indexOf(startMarker);assert.notEqual(start,-1,`missing ${startMarker}`);
  const end=core.indexOf(endMarker,start);assert.notEqual(end,-1,`missing ${endMarker}`);
  return core.slice(start,end);
}
const sandbox={window:{},norm:value=>String(value??'').trim().replace(/\s+/g,' ').toUpperCase(),spxTN:r=>String(r?.['SLS Tracking Number']??r?.['SPX TN']??r?.['Tracking Number']??'').trim().toUpperCase()};
vm.createContext(sandbox);
vm.runInContext(extract('function parseCSV(text){','\nwindow.__badocParseCSV=parseCSV;'),sandbox);
vm.runInContext(extract('function badocPickupTimeValue(row){','\nwindow.__badocMergeParcelRows=mergeParcelRowsPreservingPickup;'),sandbox);
vm.runInContext(extract('function mergeRowsUnique(rows){','\nfunction mergeAllBatches(){'),sandbox);

test('CSV parser handles BOM, quoted commas, escaped quotes and CRLF',()=>{
  const rows=sandbox.parseCSV('\uFEFFSLS Tracking Number,Town Name,Remark\r\nSPEPH123,"BADOC, NORTH","said ""hello"""');
  assert.equal(rows.length,1);assert.equal(rows[0]['Town Name'],'BADOC, NORTH');assert.equal(rows[0].Remark,'said "hello"');
});
test('CSV parser rejects unclosed quotes and duplicate headers',()=>{
  assert.throws(()=>sandbox.parseCSV('TN,Name\n"SPEPH123,John'),/opening quote/);
  assert.throws(()=>sandbox.parseCSV('TN,tn\n1,2'),/duplicate column header/i);
});
test('latest Forward/Return export merge preserves the prior pickup timestamp',()=>{
  assert.match(core,/const merged=mergeParcelRowsPreservingPickup\(existing\|\|\{\},exportRow\);/);
  assert.match(core,/merged\[\"Parcel Status To\"\]=planningStatus;/);
});

test('row merge preserves known town and pickup data when newer export is blank',()=>{
  const merged=sandbox.mergeParcelRowsPreservingPickup({'SLS Tracking Number':'SPEPH123','Town Name':'BADOC','Pick Up Time':'2026-11-24 06:00','Status':'In Transit'},{'SLS Tracking Number':'SPEPH123','Town Name':'','Status':'Delivered','Pick Up Time':''});
  assert.equal(merged['Town Name'],'BADOC');assert.equal(merged['Pick Up Time'],'2026-11-24 06:00');assert.equal(merged.Status,'Delivered');
});
test('TN-only and OID-only rows reconcile to one parcel when an identifier connects them',()=>{
  const rows=sandbox.mergeRowsUnique([
    {'SLS Tracking Number':'SPEPH123','Town Name':'BADOC'},
    {'Order ID':'OID-9','Town Name':'BADOC'},
    {'SLS Tracking Number':'SPEPH123','Order ID':'OID-9','Status':'Delivered'}
  ]);
  assert.equal(rows.length,1);assert.equal(rows[0]['Order ID'],'OID-9');assert.equal(rows[0].Status,'Delivered');
});

test('CFR1 Rule B uses original per-row upload provenance after cloud synchronization',()=>{
  const runtime=readFileSync(resolve(root,'js/240-operation-runtime.js'),'utf8');
  assert.match(runtime,/btime:Number\(r\?\._badoc_sourceUploadedAt\|\|b\?\.time\|\|0\)/);
  const cloud=readFileSync(resolve(root,'js/210-shared-cloud-sync.js'),'utf8');
  assert.match(cloud,/_badoc_sourceUploadedAt/);
});

test('Daily History and CFR summary captures perform read-back verification',()=>{
  const history=readFileSync(resolve(root,'js/410-cloud-daily-history.js'),'utf8');
  assert.match(history,/Daily History read-back verification failed/);
  assert.match(history,/CFR summary read-back verification failed/);
  assert.match(history,/for\(let attempt=0;attempt<3;attempt\+\+\)/);
});
test('storage health and local recovery export are exposed',()=>{
  assert.match(core,/__badocGetStorageHealth/);assert.match(core,/__badocExportLocalParcelBackup/);
  const health=readFileSync(resolve(root,'js/500-health-ui.js'),'utf8');
  assert.match(health,/shExportParcelBackup/);
});
test('Chrome and Firefox extension manifests exist and reference their background entrypoints',()=>{
  const chrome=JSON.parse(readFileSync(resolve(root,'extension/manifest.json'),'utf8'));
  const firefox=JSON.parse(readFileSync(resolve(root,'extension-firefox/manifest.json'),'utf8'));
  assert.equal(chrome.manifest_version,3);assert.ok(existsSync(resolve(root,'extension',chrome.background.service_worker)));
  assert.ok(existsSync(resolve(root,'extension-firefox',firefox.background.scripts?.[0]||firefox.background.service_worker||'')));
});
test('cloud uploads and cloud clears share a cross-device writer lease',()=>{
  const cloud=readFileSync(resolve(root,'js/210-shared-cloud-sync.js'),'utf8');
  assert.match(cloud,/badoc-shared-file-writer-v1/);
  assert.match(cloud,/await acquireSharedFileWriterLease\(\);sharedWriterLease=true/);
  assert.match(cloud,/if\(sharedWriterLease\)await releaseSharedFileWriterLease\(\)/);
});
test('daily reset script recognizes a valid empty parcel dataset',()=>{
  const reset=readFileSync(resolve(root,'tools/auto-reset.mjs'),'utf8');
  assert.match(reset,/Array\.isArray\(current\.valid\).*Array\.isArray\(current\.mis\).*Array\.isArray\(current\.rows\)/s);
});


test('cloud row insert is atomic and cannot overwrite a concurrent existing row',async()=>{
  const adapter=readFileSync(resolve(root,'js/050-cloud-adapter.js'),'utf8');
  const start=adapter.indexOf('async function insertRowAtomically(table, payload) {');
  assert.notEqual(start,-1,'atomic insert helper exists');
  const end=adapter.indexOf('\n\n  function Query(table)',start);
  assert.notEqual(end,-1,'atomic insert helper boundary exists');
  const store={};
  const isolated={
    getDb:async()=>({}),
    enc:value=>encodeURIComponent(String(value)).replace(/\./g,'%2E')||'_',
    ref:(_db,path)=>({transaction:async update=>{
      const current=Object.prototype.hasOwnProperty.call(store,path)?store[path]:null;
      const next=update(current);
      if(next===undefined)return {committed:false,snapshot:{val:()=>current}};
      store[path]=next;
      return {committed:true,snapshot:{val:()=>next}};
    }}),
    parseRow:node=>node&&typeof node.j==='string'?JSON.parse(node.j):null
  };
  vm.createContext(isolated);
  vm.runInContext(adapter.slice(start,end),isolated);
  const first=await isolated.insertRowAtomically('settings',{id:'global',value:'first'});
  const second=await isolated.insertRowAtomically('settings',{id:'global',value:'second'});
  assert.equal(first.duplicate,false);
  assert.equal(first.row.value,'first');
  assert.equal(second.duplicate,true);
  assert.equal(second.row.value,'first');
});


test('menu navigation defers heavy page rendering and avoids duplicate forecast recalculation',()=>{
  const start=core.indexOf('function showPage(p){');assert.notEqual(start,-1);
  const end=core.indexOf('\n$("parcelIncomingVolumeBtn")',start);assert.notEqual(end,-1);
  const nav=core.slice(start,end);
  assert.match(nav,/requestAnimationFrame/);
  assert.match(nav,/badocMenuRenderToken/);
  assert.doesNotMatch(nav,/updateOperationProgress/);
});

test('Linehaul rendering shares parcel indexes across tasks and clears its detail cache',()=>{
  const start=core.indexOf('function renderLinehaulCore(){');assert.notEqual(start,-1);
  const end=core.indexOf('\nfunction renderLinehaul(){',start);assert.notEqual(end,-1);
  const block=core.slice(start,end);
  const taskLoop=block.indexOf('linehaulTasks.forEach((task,taskIndex)=>{');
  assert.notEqual(taskLoop,-1);
  assert.ok(block.indexOf('const taskMisMap=new Map();')<taskLoop);
  assert.ok(block.indexOf('const parcelOrderIndex=new Set();')<taskLoop);
  const inner=block.slice(taskLoop);
  assert.doesNotMatch(inner,/const taskMisMap=new Map\(\)/);
  assert.doesNotMatch(inner,/const parcelOrderIndex=new Set\(\)/);
  assert.match(block,/detailStore\.clear\(\)/);
});

test('KPI menu reuses fresh sheet data and deduplicates concurrent pulls',()=>{
  assert.match(core,/__badocKpiLastSuccessAt/);
  assert.match(core,/__badocKpiLoadPromise/);
  assert.match(core,/now-lastSuccess<REFRESH_MS/);
});


test('Volume Forecast maps parcel rows once per source dataset and reuses them for filtering',()=>{
  const forecast=readFileSync(resolve(root,'js/510-volume-forecast-board.js'),'utf8');
  assert.match(forecast,/sourceRowsDetailsCache!==d\|\|sourceRowsArrayCache!==boardRows/);
  assert.match(forecast,/sourceRowsCache\.push\(/);
  assert.match(forecast,/selectedRows\(rows\)/);
  assert.doesNotMatch(forecast,/var shown=selectedRows\(\)/);
});

test('Volume Forecast town cards use a single town aggregation instead of filtering the full list per town',()=>{
  const forecast=readFileSync(resolve(root,'js/510-volume-forecast-board.js'),'utf8');
  assert.match(forecast,/function buildTownStats\(rows,sets\)/);
  assert.match(forecast,/var shown=selectedRows\(rows\),townStats=buildTownStats\(shown,sets\)/);
  const start=forecast.indexOf('function renderTownGroups(');
  const end=forecast.indexOf('function csvCell(',start);
  assert.notEqual(start,-1);assert.notEqual(end,-1);
  const renderer=forecast.slice(start,end);
  assert.doesNotMatch(renderer,/rows\.filter\(/);
  assert.match(renderer,/townStats\.get\(normText\(name\)\)/);
});

test('Volume Forecast skips full rendering while its page is hidden at startup',()=>{
  const forecast=readFileSync(resolve(root,'js/510-volume-forecast-board.js'),'utf8');
  assert.match(forecast,/function init\(\)\{\s*bind\(\);\s*if\(el\("volumeForecastBoard"\)\?\.classList\.contains\("active"\)\)render\(\);/);
});


test('Pickup results hide Record Type and sort assigned rider names ascending',()=>{
  const marker='const columns=[';
  const start=core.indexOf(marker);assert.notEqual(start,-1);
  const end=core.indexOf('if(table&&$("firstMile")',start);assert.notEqual(end,-1);
  const columns=core.slice(start,end);
  assert.doesNotMatch(columns,/Record Type/);
  assert.match(core,/new Intl\.Collator\("en",\{sensitivity:"base",numeric:true\}\)/);
  assert.match(core,/riderCollator\.compare\(a\.rider,b\.rider\)/);
  assert.match(core,/aUnassigned\?1:-1/);
});

test('Pickup results render every filtered row without virtual scrolling or a 2000-row cap',()=>{
  const start=core.indexOf('if(table&&$("firstMile")',core.indexOf('function renderFirstMileCombined'));
  const end=core.indexOf('if(downloadBtn)downloadBtn.disabled=!filtered.length;',start);
  assert.notEqual(start,-1);assert.notEqual(end,-1);
  const render=core.slice(start,end);
  assert.match(render,/visibleGroups\.map\(rowHtml\)\.join\(''\)/);
  assert.doesNotMatch(render,/renderWindow|virtualStart|virtualEnd|maxRows|2000/);
  assert.match(readFileSync(resolve(root,'css/app.css'),'utf8'),/\.first-mile-combined-table\{[\s\S]*?max-height:none!important;[\s\S]*?overflow-y:visible!important;/);
});


test('Pickup CSV export also omits the Record Type field',()=>{
  const start=core.indexOf('$("downloadFirstMileCombined")?.addEventListener("click"');
  const end=core.indexOf('$("downloadFirstMileOrders")',start);
  assert.notEqual(start,-1);assert.notEqual(end,-1);
  const exporter=core.slice(start,end);
  assert.match(exporter,/const headers=\["Order Number","Pickup Task Number"/);
  assert.doesNotMatch(exporter,/Record Type|g\.taskOnly\?"Pickup Task"/);
});


test('Light theme has readable colors for Planning Board, Collapse Menu and Linehaul sync',()=>{
  const css=readFileSync(resolve(root,'css/app.css'),'utf8');
  assert.match(css,/html\[data-theme="light"\] \.side \.planning-board-nav\.open \.planning-board-primary[\s\S]*?background:#e8f2ff!important;[\s\S]*?color:#17436b!important;/);
  assert.match(css,/html\[data-theme="light"\] \.side > \.sidebar-footer > #sideCollapseBtn[\s\S]*?background:#edf5fc!important;[\s\S]*?color:#234967!important;/);
  assert.match(css,/html\[data-theme="light"\] #linehaul #syncLinehaulFromSPX[\s\S]*?background:#1d63bd!important;[\s\S]*?color:#fff!important;/);
});


test('Light mode keeps an expanded non-active Planning Board neutral',()=>{
  const css=readFileSync(resolve(root,'css/app.css'),'utf8');
  assert.match(css,/\.planning-board-nav\.open \.planning-board-primary:not\(\.active\)[\s\S]*?background:transparent!important;[\s\S]*?box-shadow:none!important;/);
  assert.match(css,/\.planning-board-primary\.active\{[\s\S]*?background:#e8f2ff!important;/);
});

test('Light mode recolors the entire sidebar footer and theme switch row',()=>{
  const css=readFileSync(resolve(root,'css/app.css'),'utf8');
  assert.match(css,/html\[data-theme="light"\] \.side > \.sidebar-footer\{[\s\S]*?background:#f4f7fb!important;/);
  assert.match(css,/html\[data-theme="light"\] \.side > \.sidebar-footer > \.theme-switch-row\{[\s\S]*?background:#edf4fa!important;/);
  assert.match(css,/html\[data-theme="light"\] \.side > \.sidebar-footer \.theme-switch-label,[\s\S]*?color:#40566b!important;/);
});

test('Actual Scanned OnHold snapshot filters status 5, Badoc Hub, Assigned Time and duplicate tracking numbers',()=>{
  const start=bridgeBackground.indexOf('function filterActualScannedOnHoldExportRows(');
  const end=bridgeBackground.indexOf('\nfunction actualScannedOnHoldDateRange(',start);
  assert.notEqual(start,-1);assert.notEqual(end,-1);
  const helper=bridgeBackground.slice(start,end);
  const sandbox={
    findAssignedExportColumn(headers,aliases){
      const wanted=new Set(aliases.map(value=>String(value).toLowerCase().replace(/[^a-z0-9]/g,'')));
      return headers.findIndex(value=>wanted.has(String(value).toLowerCase().replace(/[^a-z0-9]/g,'')));
    },
    philippineDateKey(value){
      const match=String(value??'').match(/^(\d{4}-\d{2}-\d{2})/);
      return match?match[1]:'';
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(helper+'\nthis.filter=filterActualScannedOnHoldExportRows;',sandbox);
  const headers=['SLS Tracking Number','Current Station','Status','Assigned Time','Driver Name','Town Name'];
  const result=sandbox.filter({headers,rows:[
    ['SPEPH0001','Badoc Hub','OnHold','2026-11-28 08:10:00','Rider A','TOWN A'],
    ['SPEPH0001','Badoc Hub','OnHold','2026-11-28 08:10:00','Rider A','TOWN A'],
    ['SPEPH0002','Badoc Hub','Delivered','2026-11-28 09:00:00','Rider B','TOWN B'],
    ['SPEPH0003','Pinili Hub','OnHold','2026-11-28 09:00:00','Rider C','TOWN C'],
    ['SPEPH0004','Badoc Hub','OnHold','2026-11-27 09:00:00','Rider D','TOWN D'],
    ['','Badoc Hub','OnHold','2026-11-28 10:00:00','Rider E','TOWN E']
  ]},'2026-11-28');
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0]['SLS Tracking Number'],'SPEPH0001');
  assert.equal(result.rows[0]['Driver Name'],'Rider A');
  assert.equal(result.rows[0]._badocOnholdSnapshotKind,'spx-assigned-onhold-today');
  assert.equal(result.rows[0]._badocOnholdSnapshotDate,'2026-11-28');
  assert.equal(result.duplicateCount,1);
  assert.equal(result.excluded.otherStatus,1);
  assert.equal(result.excluded.otherStation,1);
  assert.equal(result.excluded.otherAssignedDate,1);
  assert.equal(result.excluded.missingTrackingNumber,1);
});

test('Actual Scanned OnHold script initializes rider alias arrays before extending them',()=>{
  const start=onholdHistory.indexOf('const AT_NUMBER_ALIASES =');
  const end=onholdHistory.indexOf('const INVALID_DRIVER =',start);
  assert.notEqual(start,-1);assert.notEqual(end,-1);
  const declarations=onholdHistory.slice(start,end);
  const aliases=vm.runInNewContext(declarations+'\n({riderIds:RIDER_ID_ALIASES,riderNames:RIDER_NAME_ALIASES,taskRiderIds:TASK_RIDER_ID_ALIASES,taskRiderNames:TASK_RIDER_NAME_ALIASES})');
  assert.ok(aliases.riderIds.includes('Driver ID'));
  assert.ok(aliases.riderNames.includes('Driver Name'));
  assert.ok(aliases.taskRiderIds.includes('Assigned Rider ID'));
  assert.ok(aliases.taskRiderNames.includes('Assigned Driver Name'));
});

test('Actual Scanned OnHold legacy key save is defined and cannot block primary persistence',()=>{
  const start=onholdHistory.indexOf('function loadLegacyKeys()');
  const end=onholdHistory.indexOf('function dateKeyFromRaw(',start);
  assert.notEqual(start,-1);assert.notEqual(end,-1);
  const helpers=onholdHistory.slice(start,end);
  assert.match(helpers,/function saveLegacyKeys\(\)/);
  const values=new Map([['badoc_hold_history_v2',JSON.stringify(['OLDTN'])]]);
  const sandbox={
    HISTORY_KEY:'badoc_hold_history_v2',
    historyByKey:new Map([['2026-11-28|CURRENTTN',{tn:'SPE-PH-Current-TN'}]]),
    key:value=>String(value??'').toUpperCase().replace(/[^A-Z0-9]/g,''),
    localStorage:{
      getItem:key=>values.get(key)||null,
      setItem:(key,value)=>values.set(key,value)
    },
    console:{warn(){}}
  };
  vm.createContext(sandbox);
  vm.runInContext(helpers,sandbox);
  vm.runInContext('saveLegacyKeys()',sandbox);
  const saved=JSON.parse(values.get('badoc_hold_history_v2'));
  assert.deepEqual(Array.from(saved).sort(),['OLDTN','SPEPHCURRENTTN'].sort());
  sandbox.localStorage.setItem=()=>{throw new Error('storage quota exceeded')};
  assert.doesNotThrow(()=>vm.runInContext('saveLegacyKeys()',sandbox));
});

test('Actual Scanned OnHold history uses Assigned Time for SPX status-5 snapshot dates',()=>{
  assert.match(onholdHistory,/snapshotKind === "spx-assigned-onhold-today"[\s\S]*?dateKeyFromRaw\(assignedRaw, snapshotDate/);
  assert.match(onholdHistory,/assignedAt: assignedRaw/);
  assert.match(onholdHistory,/BADOC_ACTUAL_SCANNED_ONHOLD_TODAY_COMPLETE/);
});

test('Modified Actual Scanned OnHold bridge and history scripts parse as JavaScript',()=>{
  assert.doesNotThrow(()=>new vm.Script(bridgeBackground,{filename:'extension/background.js'}));
  assert.doesNotThrow(()=>new vm.Script(readFileSync(resolve(root,'extension/content.js'),'utf8'),{filename:'extension/content.js'}));
  assert.doesNotThrow(()=>new vm.Script(onholdHistory,{filename:'js/580-actual-scanned-onhold-history.js'}));
});
