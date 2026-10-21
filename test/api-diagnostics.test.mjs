import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Store,minuteOf} from '../lib/store.mjs';
import {measureRequest} from '../lib/ai-recorder.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const expectedVersion=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function mcp(messages,env,flags=[]) {
 const child=spawn(process.execPath,[path.join(root,'mcp.mjs'),...flags],{env:{...process.env,...env},windowsHide:true});let out='',err='';
 child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.stdin.end(messages.map(m=>typeof m==='string'?m:JSON.stringify(m)).join('\n')+'\n');
 await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});assert.equal(err,'');return out.trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
}
test('stdio MCP negotiates, defaults to read-only and validates arguments without extra stdout',async()=>{
 const rows=await mcp([{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'netscope_control',arguments:{action:'pause'}}},'not-json'],{});
 assert.equal(rows[0].result.serverInfo.version,expectedVersion);assert.equal(rows.length,4);assert.equal(rows[0].result.protocolVersion,'2025-06-18');assert.equal(rows[1].result.tools.length,13);assert.ok(rows[1].result.tools.every(t=>t.annotations.readOnlyHint));assert.equal(rows[2].error.code,-32602);assert.equal(rows[3].error.code,-32700);
});
test('isolated HTTP routes, mutations, export and real MCP calls share the same evidence',async()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'netscope-api-'));
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 fs.writeFileSync(path.join(temporary,'settings.json'),JSON.stringify({port,systemEnabled:false,alertEnabled:false,paused:true}));
 const s=new Store(path.join(temporary,'traffic.sqlite'));const at=minuteOf(Date.now())-60000;
 s.append([{time:at,name:'dev.exe',path:'C:\\PRIVATE\\dev.exe',pid:700,host:'PRIVATE.example',route:'PROXY',chain:'PRIVATE_HOP',rule:'DomainSuffix',rulePayload:'example',up:12345,down:600}]);s.close();
 const env={...process.env,NETSCOPE_DATA_DIR:temporary,NETSCOPE_OFFLINE:'1'};
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',path.join(root,'server.mjs')],{env,windowsHide:true});let errors='';child.stderr.on('data',b=>errors+=b);child.stdout.resume();
 const base=`http://127.0.0.1:${port}/api/v1/`;let token;
 const call=async(endpoint,body,method='POST',authorized=true)=>{const opts=body===undefined?{}:{method,headers:{'Content-Type':'application/json',...(authorized?{'X-NetScope-Key':token}:{})},body:JSON.stringify(body)};const response=await fetch(base+endpoint,opts);return {status:response.status,value:await response.json()};};
 try {
  let ready=false;for(let i=0;i<60;i++){try{const r=await call('session');if(r.status===200){token=r.value.token;ready=true;break;}}catch{}await pause(50);}assert.ok(ready,errors);
  assert.equal((await call('status')).value.version,expectedVersion);
  const peak=(await call('peaks')).value.rows[0];assert.equal(peak.uploadBytes,12345);
  assert.equal((await call('replay?at='+at)).value.flows[0].name,'dev.exe');
  const routes=(await call('routes')).value;assert.equal(routes.rows[0].rule,'DomainSuffix');
  assert.equal((await call('trust')).status,200);
  assert.equal((await call('projects',{name:'Denied'},'POST',false)).status,403);
  const project=(await call('projects',{name:'Work'})).value;
  assert.equal((await call('project-rules',{projectId:project.id,kind:'domain',value:'private.example'})).status,200);
  assert.equal((await call('projects')).value.rows[0].uploadBytes,12345);
  const rule=(await call('rules',{name:'Budget',kind:'budget',limitBytes:1e9})).value;
  assert.equal((await call('rules?id='+rule.id,{enabled:false},'PATCH')).value.enabled,false);
  assert.equal((await call('ai/metrics',{metrics:[{...measureRequest({hello:'world'},{provider:'sdk'}),body:'NOT_ALLOWED'}]})).status,400);
  assert.equal((await call('ai/metrics',{metrics:[measureRequest({hello:'world'},{provider:'sdk'})]})).value.inserted,1);
  assert.equal((await call('ai')).value.totals.requests,1);
  assert.equal((await call('probes',{host:'https://invalid/path'})).status,400);
  const bundle=(await call('bundle')).value;assert.ok(!JSON.stringify(bundle).includes('PRIVATE'));
  const result=await mcp([{jsonrpc:'2.0',id:10,method:'tools/call',params:{name:'netscope_peaks',arguments:{range:'all'}}},{jsonrpc:'2.0',id:11,method:'tools/call',params:{name:'netscope_create_project',arguments:{name:'Created by MCP'}}}],{NETSCOPE_DATA_DIR:temporary},['--allow-control']);
  assert.equal(result[0].result.structuredContent.rows[0].uploadBytes,12345);assert.equal(result[1].result.isError,false);
  assert.equal((await call('projects')).value.rows.length,2);
  assert.equal((await call('rules?id='+rule.id,{},'DELETE')).status,200);
  assert.equal((await call('projects?id='+project.id,{},'DELETE')).status,200);
 }finally{try{await call('control',{action:'stop'});}catch{}await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);});}
 assert.equal(errors,'');
});
