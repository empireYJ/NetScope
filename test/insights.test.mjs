import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {Store,keyOf,minuteOf} from '../lib/store.mjs';
import {Insights,periodWindow} from '../lib/insights.mjs';
import {AiDiagnostics} from '../lib/ai.mjs';
import {measureRequest} from '../lib/ai-recorder.mjs';
import {NetworkDiagnostics,validateProbe} from '../lib/diagnostics.mjs';
import {diagnosticBundle} from '../lib/bundle.mjs';
const fixture=()=>{const folder=fs.mkdtempSync(path.join(os.tmpdir(),'netscope-insights-'));const store=new Store(path.join(folder,'traffic.sqlite'));return {folder,store,insights:new Insights(store),ai:new AiDiagnostics(store)};};
const now=Date.now(),at=minuteOf(now)-600000;
const row=(up,extra={})=>({time:at,name:'dev.exe',path:'C:\\PrivateUser\\dev.exe',pid:100,started:'2026-10-21T00:00:00Z',host:'private-target.example',port:443,protocol:'TCP',route:'PROXY',chain:'private-node → group',source:'clash',up,down:10,...extra});

test('peak replay and comparison preserve direction, time and internal layer boundaries',()=>{
 const {store:s,insights:i}=fixture();try{
  s.append([row(20),row(300,{time:at+60000,rule:'DomainSuffix',rulePayload:'example',inboundType:'HTTPS'}),row(9999,{time:at+60000,route:'TRANSPORT'})]);
  const peak=i.peaks().rows[0];assert.equal(peak.time,at+60000);assert.equal(peak.uploadBytes,300);
  const replay=i.replay({at:String(at+60000),minutes:1});assert.equal(replay.totals[0].uploadBytes,300);assert.equal(replay.processes[0].pid,100);
  const route=i.route(replay.flows[0].flowId);assert.equal(route.rule,'DomainSuffix');assert.equal(route.steps.find(s=>s.kind==='rule').value,'example');
  assert.match(i.route(i.flowRows({from:at,to:at+59999})[0].flowId).confidence,/不能反推/);
  const change=i.compare({from:at+60000,to:at+119999,baselineFrom:at,baselineTo:at+59999});assert.equal(change.rows[0].uploadDelta,280);
  assert.throws(()=>i.replay({at:'invalid'}));
 }finally{s.close();}
});
test('project process trees use process lifetimes; overlaps remain explicit',()=>{
 const {store:s,insights:i}=fixture();try{
  const root='2026-10-21T00:00:00Z',child='2026-10-21T00:00:01Z',reused='2026-10-21T01:00:01Z';
  i.recordProcesses([{pid:100,started:root,name:'editor.exe',parentPid:1},{pid:200,started:child,parentPid:100,name:'dev.exe'}],now);
  s.append([row(100,{pid:200,started:child}),row(700,{pid:200,started:reused}),row(20,{pid:300,started:child,host:'notprivate-target.example.invalid'})]);
  const project=i.createProject({name:'Build'}),other=i.createProject({name:'Target'});
  i.addProjectRule(project.id,{kind:'process-tree',value:{pid:100,started:root}});i.addProjectRule(other.id,{kind:'domain',value:'private-target.example'});
  const grouped=i.projects();assert.equal(grouped.rows[0].uploadBytes,100);assert.equal(grouped.rows[1].uploadBytes,800);assert.equal(grouped.overlappingBytes,110);assert.equal(grouped.unassignedBytes,30);
  assert.throws(()=>i.addProjectRule(project.id,{kind:'process-tree',value:{pid:100}}));
 }finally{s.close();}
});
test('trust reports unknown attribution separately from unknown routing and shows real gaps',()=>{
 const {store:s,insights:i}=fixture();try{
  s.append([row(90),row(10,{name:'未知程序',path:'',pid:0,route:'DIRECT'}),row(30,{route:'UNKNOWN'}),row(9999,{route:'TRANSPORT'})],[],[{time:at,globalUp:100,globalDown:20,observedUp:100,observedDown:20},{time:at+120000,globalUp:0,globalDown:0,observedUp:0,observedDown:0}]);
  s.setMeta('recording_since',new Date(at).toISOString());s.event('coverage_gap','known gap',at+60000);
  const r=i.trust({from:at,to:at+179999});assert.equal(r.unidentifiedBytes,20);assert.equal(r.unclassifiedRouteBytes,40);assert.equal(r.gapCount,1);assert.equal(r.gaps[0].from,at+60000);assert.equal(r.internal.uploadBytes,9999);assert.equal(r.events[0].kind,'coverage_gap');
 }finally{s.close();}
});
test('per-app budgets exclude transport and persist cooldown; new-target notifications deduplicate',()=>{
 const {store:s,insights:i}=fixture();try{
  s.append([row(60,{time:now-2000}),row(999,{time:now-2000,route:'TRANSPORT'})]);
  i.saveRule({name:'Dev budget',kind:'budget',programKey:keyOf('dev.exe','C:\\PrivateUser\\dev.exe'),direction:'upload',limitBytes:100});
  const config={alertEnabled:true,paused:false};assert.equal(i.evaluateRules(config,now).length,0);
  s.append([row(50,{time:now-1000})]);assert.equal(i.evaluateRules({...config,paused:true},now).length,0);assert.equal(i.evaluateRules(config,now).length,1);assert.equal(i.evaluateRules(config,now+1000).length,0);
  const rule=i.saveRule({name:'New target',kind:'new-destination'});s.db.prepare('UPDATE alert_rules SET created_ms=? WHERE id=?').run(now-1500,rule.id);
  s.append([row(1,{time:now-1000,host:'fresh.example'})]);assert.equal(i.evaluateRules(config,now).length,1);assert.equal(i.evaluateRules(config,now+1000).length,0);
  assert.throws(()=>i.saveRule({name:'Bad',kind:'budget',route:'TRANSPORT'}));
  assert.equal(periodWindow('month',now).from,new Date(new Date(now).getFullYear(),new Date(now).getMonth(),1).getTime());
 }finally{s.close();}
});
test('AI metadata measurements deduplicate requests and hash repeat images without retaining bodies',()=>{
 const {store:s,ai}=fixture();try{
  const body={input:[{type:'input_image',image_url:'data:image/png;base64,YWJjZGVm'}],privateToken:'DO_NOT_RETAIN_BODY'};
  const a=measureRequest(body,{provider:'sdk',requestId:'one',sessionId:'PRIVATE_SESSION',time:now-1000,postBytes:100,attempt:1});
  const b=measureRequest(body,{provider:'sdk',requestId:'two',sessionId:'PRIVATE_SESSION',time:now,postBytes:100,attempt:2});
  assert.equal(ai.ingest([a,b]).inserted,2);assert.equal(ai.ingest([a]).duplicates,1);
  const summary=ai.summary();assert.equal(summary.totals.requests,2);assert.equal(summary.repeatedImages.length,1);assert.equal(summary.totals.reportedRetries,1);assert.equal(summary.sessions[0].imageMeasuredRequests,2);
  const saved=JSON.stringify(s.db.prepare('SELECT * FROM ai_metrics').all());assert.ok(!saved.includes('DO_NOT_RETAIN_BODY'));assert.ok(!saved.includes('PRIVATE_SESSION'));
  assert.throws(()=>ai.ingest([{provider:'sdk',preBytes:10,imageBytes:20}]));assert.equal(ai.summary().totals.requests,2);
 }finally{s.close();}
});
test('Codex adapter reads only size metadata and preserves prepared status',()=>{
 const {folder,store:s,ai}=fixture();try{
  const file=path.join(folder,'source.sqlite'),db=new DatabaseSync(file);db.exec('CREATE TABLE logs(id INTEGER,ts INTEGER,ts_nanos INTEGER,thread_id TEXT,process_uuid TEXT,target TEXT,feedback_log_body TEXT)');
  db.prepare('INSERT INTO logs VALUES(?,?,?,?,?,?,?)').run(1,Math.floor(now/1000),0,'PRIVATE_THREAD','proc','codex_http_client::request','message="Compressed request body with zstd pre_compression_bytes=500 post_compression_bytes=300" secret=PRIVATE_AUTH');db.close();
  assert.equal(ai.scanCodex({filename:file,now}).imported,1);assert.equal(ai.scanCodex({filename:file,now}).imported,0);const summary=ai.summary();assert.equal(summary.rows[0].postBytes,300);assert.equal(summary.rows[0].status,'prepared');assert.equal(summary.rows[0].imageBytes,null);assert.ok(!JSON.stringify(summary).includes('PRIVATE_AUTH'));
 }finally{s.close();}
});
test('redacted export excludes paths, hosts, node names, project labels, event text and credentials',()=>{
 const {store:s,insights:i,ai}=fixture();try{
  s.append([row(10)]);i.createProject({name:'PRIVATE_CUSTOMER_PROJECT'});s.event('sensor_error','PRIVATE_TOKEN_123 and C:\\PrivateUser\\auth',at);
  const bundle=diagnosticBundle(s,i,ai);const json=JSON.stringify(bundle);
  for(const secret of ['PrivateUser','private-target.example','private-node','PRIVATE_CUSTOMER_PROJECT','PRIVATE_TOKEN_123'])assert.ok(!json.includes(secret),secret);
  assert.equal(bundle.records[0].program,bundle.programs[0].key);assert.equal(bundle.privacy.hostnamesIncluded,false);
  assert.equal(diagnosticBundle(s,i,ai,{includeHosts:true}).records[0].host,'private-target.example');
 }finally{s.close();}
});
test('retention cleans all new historical tables while preserving configured rules',()=>{
 const {store:s,insights:i,ai}=fixture();try{
  const old=now-40*86400000;i.createProject({name:'Keep preference'});i.saveRule({name:'Keep budget',kind:'budget'});
  ai.ingest([measureRequest({image:'data:image/png;base64,YWJj'},{provider:'sdk',time:old})]);
  s.db.prepare('INSERT INTO network_probes VALUES(?,?,?,?,?,?)').run('old',old,'example.invalid',443,'system','{}');
  i.recordProcesses([{pid:90,started:new Date(old).toISOString(),name:'old.exe'}],old);
  s.cleanup(30,now);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM ai_metrics').get().n,0);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM ai_images').get().n,0);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM process_sessions').get().n,0);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM network_probes').get().n,0);assert.equal(i.projects().rows.length,1);assert.equal(i.rules().rows.length,1);
 }finally{s.close();}
});
test('bounded connection diagnostics perform actual local TCP handshakes and retain results',async()=>{
 const {store:s}=fixture();const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const result=await new NetworkDiagnostics(s).run({host:'127.0.0.1',port:server.address().port,count:3,tls:false});assert.equal(result.summary.successes,3);assert.ok(result.rows.every(r=>r.tcpMs!==null));assert.equal(s.db.prepare('SELECT COUNT(*) n FROM network_probes').get().n,1);
  assert.throws(()=>validateProbe({host:'https://example.com/path'}));assert.throws(()=>validateProbe({host:'localhost\r\nBad: value'}));assert.throws(()=>validateProbe({host:'localhost',count:100}));
 }finally{await new Promise(r=>server.close(r));s.close();}
});
test('spike and first-program rules require evidence and suppress repeated notifications',()=>{
 const {store:s,insights:i}=fixture();try{
  const end=minuteOf(now);for(let n=1;n<=15;n++)s.append([row(10,{time:end-n*60000,down:0})]);
  i.saveRule({name:'Spike',kind:'spike',direction:'upload',limitBytes:50,factor:3});s.append([row(80,{time:end,down:0})]);
  assert.equal(i.evaluateRules({alertEnabled:true,paused:false},now)[0].kind,'spike');assert.equal(i.evaluateRules({alertEnabled:true,paused:false},now+100).length,0);
  const rule=i.saveRule({name:'First app',kind:'new-program'});s.db.prepare('UPDATE alert_rules SET created_ms=? WHERE id=?').run(now-500,rule.id);
  s.append([row(1,{time:now,name:'new.exe',path:'C:\\new.exe',pid:999})]);const alerts=i.evaluateRules({alertEnabled:true,paused:false},now+1000);assert.equal(alerts.length,1);assert.equal(alerts[0].kind,'new-program');
  assert.equal(i.evaluateRules({alertEnabled:true,paused:false},now+2000).length,0);
 }finally{s.close();}
});
test('expired history is not reported as missing capture and shortened retention stays explicit',()=>{
 const {store:s,insights:i}=fixture();try{
  const old=now-40*86400000;s.setMeta('recording_since',new Date(old).toISOString());s.append([row(1,{time:old}),row(2,{time:now})]);s.cleanup(1,now);
  const r=i.trust();assert.ok(r.effectiveCoverageFrom>=minuteOf(now-86400000));s.cleanup(0,now);assert.ok(i.trust().effectiveCoverageFrom>=minuteOf(now-86400000));
 }finally{s.close();}
});
