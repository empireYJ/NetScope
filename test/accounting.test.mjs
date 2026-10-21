import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store,rangeOf,keyOf} from '../lib/store.mjs';
import {Clash,classify} from '../lib/clash.mjs';
import {Collector,extraRoute} from '../lib/collector.mjs';
import {evaluateTrafficAlert} from '../lib/alerts.mjs';
const create=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'netscope-test-'));return new Store(path.join(dir,'test.sqlite'));};
const now=Date.now();
const row=(name,route,up,down,extra={})=>({time:now,name,path:'C:\\Test\\'+name,route,up,down,host:'example.invalid',...extra});
test('four independent rankings separate route and direction and preserve sum',()=>{
 const s=create();try{s.append([row('a.exe','DIRECT',500,10),row('b.exe','DIRECT',10,600),row('c.exe','PROXY',700,20),row('d.exe','PROXY',20,800),row('a.exe','PROXY',5,4)]);const d=s.dashboard();assert.equal(d.rankings.direct_upload[0].name,'a.exe');assert.equal(d.rankings.direct_download[0].name,'b.exe');assert.equal(d.rankings.proxy_upload[0].name,'c.exe');assert.equal(d.rankings.proxy_download[0].name,'d.exe');assert.equal(d.totals.find(r=>r.route==='PROXY').uploadBytes,725);assert.equal(s.details({key:keyOf('a.exe','C:\\Test\\a.exe'),route:'DIRECT'}).summary.uploadBytes,500);}finally{s.close();}
});
test('initial counters, reconnect, core reset and pause baseline never inflate usage',()=>{
 const c=new Clash();const conn=(id,up,chains=['node'])=>({id,upload:up,download:0,chains,metadata:{process:'a.exe'}}),snap=(up,cs)=>({uploadTotal:up,downloadTotal:0,connections:cs});
 assert.equal(c.observe(snap(100,[conn('a',100)]),1000).rows.length,0);
 assert.equal(c.observe(snap(230,[conn('a',200),conn('b',30,['DIRECT'])]),2000).observedUp,130);
 c.observe(snap(230,[]),3000);assert.equal(c.observe(snap(240,[conn('a',210)]),4000).observedUp,10);
 assert.ok(c.observe(snap(0,[]),5000).reset);assert.equal(c.observe(snap(10,[conn('new',10)]),6000).observedUp,10);
 c.reset();assert.equal(c.observe(snap(999999,[conn('new',999999)]),7000).observedUp,0);
 assert.equal(classify({chains:['DIRECT']}),'DIRECT');assert.equal(classify({chains:[]}), 'UNKNOWN');
});
test('retention deletes all old dimensions and preserves recent records; zero retains',()=>{
 const s=create();try{s.append([row('old.exe','PROXY',500,20,{time:now-40*86400000}),row('new.exe','DIRECT',10,20)]);s.event('old','test',now-40*86400000);s.cleanup(0);assert.equal(s.programs().total,2);const out=s.cleanup(30,now);assert.ok(out.deletedRows>=2);assert.equal(s.programs().total,1);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM actors').get().n,1);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM flows').get().n,1);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM events').get().n,0);}finally{s.close();}
});
test('proxy transport and already observed sockets are not double counted by system sensor',()=>{
 const indices=new Set([19]),addresses=new Set(['192.168.1.2']);const f={routeIndex:19,local:'192.168.1.2',remote:'8.8.8.8'};
 assert.equal(extraRoute(f,indices,addresses,false,'verge-mihomo.exe'),'TRANSPORT');assert.equal(extraRoute(f,indices,addresses,true,'chrome.exe'),'DUPLICATE');assert.equal(extraRoute(f,indices,addresses,false,'chrome.exe'),'DIRECT');assert.equal(extraRoute({...f,routeIndex:15},indices,addresses,false,'chrome.exe'),'UNKNOWN');assert.equal(extraRoute({...f,remote:'198.18.0.8'},indices,addresses,false,'chrome.exe'),'UNKNOWN');
});
test('legacy import is atomic and idempotent and retains totals',()=>{
 const s=create(),legacy=path.join(path.dirname(s.filename),'old.sqlite'),old=new DatabaseSync(legacy);old.exec('CREATE TABLE traffic(minute,process,process_path,host,route,chains,up,down); CREATE TABLE metadata(key,value); CREATE TABLE reconciliation(minute,global_up,global_down,observed_up,observed_down,polls);');old.prepare('INSERT INTO traffic VALUES(?,?,?,?,?,?,?,?)').run(now,'a.exe','C:\\a.exe','example.invalid','PROXY','[]',100,200);old.prepare('INSERT INTO metadata VALUES(?,?)').run('recording_since','2026-10-21T08:32:25.274Z');old.close();
 try{assert.equal(s.importLegacy(legacy).rows,1);assert.equal(s.importLegacy(legacy).imported,false);assert.equal(s.programs().rows[0].totalBytes,300);}finally{s.close();}
});
test('query validation rejects inverted range and invalid route; SQL strings remain data',()=>{
 const s=create();try{s.append([row('safe.exe','PROXY',1,2)]);assert.throws(()=>rangeOf({from:'bad'}));assert.throws(()=>rangeOf({from:20,to:10}));assert.throws(()=>s.programs({route:'fake'}));assert.equal(s.programs({search:"'; DROP TABLE traffic; --"}).rows.length,0);assert.equal(s.programs().total,1);}finally{s.close();}
});
test('PID zero remains unidentified instead of becoming the idle process',()=>{
 const c=new Collector(null,{});c.processes.set(0,{pid:0,name:'System Idle Process'});
 const r=c.enrich({pid:0,name:'未知程序',path:'',protocol:'TCP',localPort:1});
 assert.equal(r.name,'未知程序');assert.equal(r.parentName,'');assert.equal(r.key,keyOf('未知程序'));
});
test('minute-record cursor traverses same-minute flows exactly once with filters',()=>{
 const s=create();try{
   s.append([row('a.exe','DIRECT',1,2),row('a.exe','DIRECT',3,4,{host:'b.invalid'}),row('a.exe','DIRECT',5,6,{time:now+60000}),row('b.exe','PROXY',9,8)]);
   const q={route:'DIRECT',to:now+120000,limit:1};const all=[];let cursor;
   do{const result=s.records({...q,cursor});all.push(...result.rows);cursor=result.nextCursor;}while(cursor);
   assert.equal(all.length,3);assert.equal(all.reduce((v,r)=>v+r.uploadBytes,0),9);
   assert.equal(new Set(all.map(r=>r.time+':'+r.flowId)).size,3);assert.throws(()=>s.records({cursor:'invalid'}));
 }finally{s.close();}
});
test('hourly alert includes VPN only, obeys pause and persists a one-hour cooldown',()=>{
 const s=create();try{
   const config={alertEnabled:true,alertHourlyGB:1,paused:false};
   s.append([row('direct.exe','DIRECT',2e9,0),row('vpn.exe','PROXY',4e8,5e8)]);
   assert.equal(evaluateTrafficAlert(s,config,now),null);
   s.append([row('vpn.exe','PROXY',1e8,0)]);
   assert.equal(evaluateTrafficAlert(s,{...config,paused:true},now),null);
   assert.equal(evaluateTrafficAlert(s,{...config,alertEnabled:false},now),null);
   const alert=evaluateTrafficAlert(s,config,now);assert.equal(alert.totalBytes,1e9);assert.equal(alert.topProgram,'vpn.exe');
   assert.equal(evaluateTrafficAlert(s,config,now+1000).id,alert.id);
   assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='traffic_alert'").get().n,1);
 }finally{s.close();}
});
