#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const core=readFileSync(resolve(root,'js/120-app-core.js'),'utf8');
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
