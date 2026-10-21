import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Clash} from '../lib/clash.mjs';
import {Store,keyOf} from '../lib/store.mjs';
import {Collector} from '../lib/collector.mjs';
import {INTERNAL_NAME,connectionVisible} from '../lib/accounting.mjs';
import {repairInternalAccounting} from '../lib/repair.mjs';
import {evaluateTrafficAlert} from '../lib/alerts.mjs';
const create=()=>new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'netscope-inner-')),'test.sqlite'));
const now=Date.now();
test('chain relay is archived once but excluded from application observation and alert',()=>{
  const s=create(),c=new Clash();
  const conn=(id,type,upload)=>({id,upload,download:0,chains:['node'],metadata:{type,process:type==='Inner'?'':'codex.exe',sourcePort:type==='Inner'?0:123}});
  try {
    c.observe({uploadTotal:100,downloadTotal:0,connections:[conn('app','HTTPS',100),conn('relay','Inner',100)]},now-1000);
    const d=c.observe({uploadTotal:600000100,downloadTotal:0,connections:[conn('app','HTTPS',600000100),conn('relay','Inner',610000100)]},now);
    assert.equal(d.observedUp,600000000);assert.equal(d.internalUp,610000000);assert.equal(d.globalUp,600000000);
    assert.equal(d.rows.find(r=>r.route==='TRANSPORT').name,INTERNAL_NAME);
    s.append(d.rows,[],[{time:now,...d}]);const report=s.dashboard();
    assert.equal(report.totals[0].uploadBytes,600000000);assert.equal(report.internal.uploadBytes,610000000);
    assert.equal(report.quality.internalUp,610000000);
    assert.equal(report.rankings.proxy_upload.length,1);assert.equal(report.rankings.proxy_upload[0].name,'codex.exe');
    assert.equal(evaluateTrafficAlert(s,{alertEnabled:true,alertHourlyGB:1,paused:false},now),null);
    assert.equal(s.programs().total,1);assert.equal(s.programs({includeTransport:'true'}).total,2);
    const details=s.details({key:keyOf(INTERNAL_NAME),route:'TRANSPORT'});
    assert.equal(details.destinations[0].inboundType,'Inner');assert.match(details.taskNote,/不加入/);
    assert.equal(s.records({route:'TRANSPORT'}).rows[0].attribution,'clash-inner');
    assert.equal(connectionVisible(d.connections.find(r=>r.route==='TRANSPORT')),false);
    assert.equal(connectionVisible(d.connections.find(r=>r.route==='TRANSPORT'),{route:'TRANSPORT'}),true);
  }finally{s.close();}
});
test('internal connections cannot inherit a fabricated idle PID or overwrite start time',()=>{
  const c=new Collector(null,{});c.sockets.set('TCP:0',[0]);c.processes.set(0,{pid:0,name:'System Idle Process'});
  const r=c.enrich({name:INTERNAL_NAME,route:'TRANSPORT',path:'',pid:0,protocol:'TCP',localPort:0,started:'2026-10-21T00:00:00Z'});
  assert.equal(r.name,INTERNAL_NAME);assert.equal(r.pid,0);assert.equal(r.started,'2026-10-21T00:00:00Z');
});
test('reviewed historical repair preserves raw bytes and rows and is idempotent',()=>{
 const s=create();try {
  s.append([{time:now,name:'未知程序',pid:0,route:'PROXY',host:'192.0.2.1',port:443,protocol:'TCP',chain:'front',source:'clash',up:600,down:20},{time:now,name:'codex.exe',route:'PROXY',up:590,down:19}],[],[{time:now,globalUp:590,globalDown:19,observedUp:1190,observedDown:39}]);
  const flow=s.db.prepare("SELECT id FROM flows WHERE host='192.0.2.1'").get().id;
  const m={id:'test',evidence:'reviewed local sample',flows:[{id:flow,host:'192.0.2.1',port:443,chain:'front'}]};
  const r=repairInternalAccounting(s,m);assert.deepEqual(r.rawBefore,r.rawAfter);assert.equal(r.moved.up,600);
  assert.equal(s.dashboard().quality.observedUp,590);assert.equal(s.dashboard().quality.internalUp,600);
  assert.equal(s.programs({search:'未知程序'}).total,0);
  assert.equal(s.records({route:'TRANSPORT'}).rows[0].inboundType,'');
  assert.equal(s.records({route:'TRANSPORT'}).rows[0].attribution,'historical-proxy-chain-match');
  assert.equal(repairInternalAccounting(s,m).alreadyApplied,true);
  assert.equal(s.dashboard().quality.internalUp,600);
 }finally{s.close();}
});
test('historical repair rejects a mismatched identity atomically',()=>{
 const s=create();try {
  s.append([{time:now,name:'未知程序',pid:0,route:'PROXY',host:'192.0.2.1',port:443,protocol:'TCP',chain:'front',up:100}]);
  const flow=s.db.prepare('SELECT id FROM flows').get().id;
  assert.throws(()=>repairInternalAccounting(s,{id:'bad',evidence:'test',flows:[{id:flow,host:'wrong',port:443,chain:'front'}]}),/mismatch/);
  assert.equal(s.programs().rows[0].name,'未知程序');assert.equal(s.db.isTransaction,false);
 }finally{s.close();}
});
