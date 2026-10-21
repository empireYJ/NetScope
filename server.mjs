import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {Store} from './lib/store.mjs';
import {Collector} from './lib/collector.mjs';
import {evaluateTrafficAlert} from './lib/alerts.mjs';
import {connectionVisible} from './lib/accounting.mjs';
import {Insights} from './lib/insights.mjs';
import {AiDiagnostics} from './lib/ai.mjs';
import {NetworkDiagnostics} from './lib/diagnostics.mjs';
import {diagnosticBundle} from './lib/bundle.mjs';
import {ROOT,DATA,VERSION,readConfig,saveConfig,validateConfig,atomicJSON} from './lib/config.mjs';
import {autoStart,autoStartEnabled,enableSystem,resumeSystem} from './lib/platform.mjs';

fs.mkdirSync(DATA,{recursive:true});
const config=readConfig();let store,collector,insights,ai,probes;let shuttingDown=false;
const offline=process.env.NETSCOPE_OFFLINE==='1';
let systemRecoveryTimer,systemRecoveryBusy=false;
let alertTimer,latestAlert=null,ruleAlerts=[];
async function recoverSystem(){if(offline||shuttingDown||systemRecoveryBusy||!config.systemEnabled||collector.status.systemOnline)return;systemRecoveryBusy=true;try{await resumeSystem();}catch{collector.status.systemError='系统采集未恢复；可在设置中重新启用。';}finally{systemRecoveryBusy=false;}}
const tokenPath=path.join(DATA,'api-token');
const token=fs.existsSync(tokenPath)?fs.readFileSync(tokenPath,'utf8').trim():crypto.randomBytes(32).toString('hex');
if(!fs.existsSync(tokenPath))fs.writeFileSync(tokenPath,token,{mode:0o600});
const origin=`http://127.0.0.1:${config.port}`;
const allowedHosts=new Set([`127.0.0.1:${config.port}`,`localhost:${config.port}`]);
function status() {return {app:'NetScope',version:VERSION,apiVersion:1,pid:process.pid,url:origin,startedAt,offline,now:Date.now(),...collector.snapshot(),alert:latestAlert,ruleAlerts,storage:store.storage(),settings:{...config,autoStart:autoStartEnabled()},recordingSince:store.getMeta('recording_since')};}
function json(res,value,code=200) {res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function authorized(req) {const received=req.headers['x-netscope-key'];return typeof received==='string'&&received.length===token.length&&crypto.timingSafeEqual(Buffer.from(received),Buffer.from(token));}
async function bodyOf(req,maxBytes=16384) {let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw new Error('Request too large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');}
async function update(change) {
  validateConfig(change);
  if(change.autoStart!==undefined)await autoStart(change.autoStart);
  if(change.paused!==undefined&&change.paused!==config.paused)collector.pause(change.paused);
  Object.assign(config,change);saveConfig(config);
  let cleanup=null;if(change.retentionDays!==undefined){collector.flush();cleanup=store.cleanup(config.retentionDays);}
  store.event('settings','Settings updated: '+Object.keys(change).join(', '));
  return {settings:{...config,autoStart:autoStartEnabled()},cleanup};
}
function csv(rows) {return '\uFEFF'+['程序,路径,上传字节,下载字节,合计字节,路线,首次记录,最后记录',...rows.map(r=>[r.name,r.path,r.uploadBytes,r.downloadBytes,r.totalBytes,r.routes,new Date(r.firstMs).toISOString(),new Date(r.lastMs).toISOString()].map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(','))].join('\r\n');}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    if(!store||!collector)return json(res,{error:'NetScope is initializing'},503);
    if(!allowedHosts.has(req.headers.host)||req.headers.origin&&!allowedHosts.has(new URL(req.headers.origin).host))return json(res,{error:'Local origin required'},403);
    if(req.headers['sec-fetch-site']==='cross-site')return json(res,{error:'Cross-site request rejected'},403);
    const url=new URL(req.url,origin),query=Object.fromEntries(url.searchParams);
    if(url.pathname.startsWith('/api/v1/')) {
      const api=url.pathname.slice(8);
      if(req.method==='GET') {
        if(api==='session')return json(res,{token,apiVersion:1});
        if(api==='status')return json(res,status());
        if(api==='peaks')return json(res,insights.peaks(query));
        if(api==='replay')return json(res,insights.replay(query));
        if(api==='compare')return json(res,insights.compare(query));
        if(api==='routes')return json(res,insights.routes(query));
        if(api==='route')return json(res,insights.route(query.flowId));
        if(api==='trust')return json(res,insights.trust(query,collector.snapshot()));
        if(api==='projects')return json(res,insights.projects(query));
        if(api==='rules')return json(res,insights.rules());
        if(api==='ai')return json(res,ai.summary(query));
        if(api==='probes')return json(res,probes.history(query));
        if(api==='bundle'){res.setHeader('Content-Disposition','attachment; filename="netscope-diagnostic.json"');return json(res,diagnosticBundle(store,insights,ai,query,collector.snapshot()));}
        if(api==='process-tree')return json(res,{time:Date.now(),rows:[...collector.processes.values()].filter(p=>p.pid>0).map(p=>({pid:p.pid,started:p.started,name:p.name,parentPid:p.parentPid})),note:'实时进程库存，不采集命令行；进程树分组须使用 PID 和创建时间共同绑定。'});
        if(api==='dashboard')return json(res,{...store.dashboard(query),live:collector.snapshot()});
        if(api==='programs')return json(res,store.programs(query));
        if(api==='records')return json(res,store.records(query));
        if(api==='program')return json(res,{...store.details(query),live:collector.connections().filter(c=>c.key===query.key&&connectionVisible(c,query))});
        if(api==='connections')return json(res,{time:Date.now(),rows:collector.connections().filter(c=>connectionVisible(c,query)&&(!query.search||(c.name+' '+c.host).toLowerCase().includes(query.search.toLowerCase())))});
        if(api==='history')return json(res,{range:store.filter(query).range,totals:store.totals(query),series:store.series(query)});
        if(api==='events')return json(res,{rows:store.db.prepare('SELECT time,kind,detail FROM events ORDER BY time DESC LIMIT 100').all()});
        if(api==='legacy')return json(res,{note:'Windows SRUM 旧记录仅用于取证，代理核心包含直连与代理，不能拆分到四个榜单。',rows:store.db.prepare('SELECT time,app,up uploadBytes,down downloadBytes FROM legacy_srum ORDER BY time DESC LIMIT 1000').all()});
        if(api==='settings')return json(res,{...config,autoStart:autoStartEnabled(),storage:store.storage(),dataDirectory:DATA,root:ROOT,lastCleanup:store.getMeta('last_cleanup')});
        if(api==='export'){
          const rows=store.programs({...query,limit:1000}).rows;
          if(query.format==='csv') {res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="netscope-programs.csv"'});return res.end(csv(rows));}
          res.setHeader('Content-Disposition','attachment; filename="netscope-programs.json"');return json(res,{exportedAt:new Date().toISOString(),range:store.filter(query).range,rows});
        }
        return json(res,{error:'Unknown endpoint'},404);
      }
      if(!authorized(req))return json(res,{error:'Valid X-NetScope-Key is required'},403);
      if(!String(req.headers['content-type']).startsWith('application/json'))return json(res,{error:'application/json required'},415);
      if(req.method==='PATCH'&&api==='settings')return json(res,await update(await bodyOf(req)));
      if(req.method==='POST'&&api==='projects'){const r=insights.createProject(await bodyOf(req));store.event('project_updated','创建项目分组');return json(res,r);}
      if(req.method==='DELETE'&&api==='projects')return json(res,insights.deleteProject(query.id));
      if(req.method==='POST'&&api==='project-rules'){const b=await bodyOf(req);return json(res,insights.addProjectRule(String(b.projectId),b));}
      if(req.method==='DELETE'&&api==='project-rules')return json(res,insights.deleteProjectRule(query.id));
      if((req.method==='POST'||req.method==='PATCH')&&api==='rules')return json(res,insights.saveRule(await bodyOf(req),query.id));
      if(req.method==='DELETE'&&api==='rules')return json(res,insights.deleteRule(query.id));
      if(req.method==='POST'&&api==='probes'){const b=await bodyOf(req);return json(res,await probes.run(b));}
      if(req.method==='POST'&&api==='ai/scan')return json(res,ai.scanCodex());
      if(req.method==='POST'&&api==='ai/metrics'){const b=await bodyOf(req,262144);return json(res,ai.ingest(b.metrics));}
      if(req.method==='POST'&&api==='control') {
        const {action}=await bodyOf(req);
        if(action==='pause'||action==='resume')return json(res,await update({paused:action==='pause'}));
        if(action==='compact'){collector.flush();store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');return json(res,{ok:true,storage:store.storage()});}
        if(action==='system-enable') {
          config.systemEnabled=true;saveConfig(config);
          if(collector.status.systemOnline)return json(res,{ok:true,alreadyRunning:true});
          const stop=path.join(DATA,'system-stop.flag');if(fs.existsSync(stop))fs.unlinkSync(stop);
          await enableSystem();return json(res,{ok:true,requested:true,message:'已请求 Windows 管理员授权；请查看采集状态是否变为已连接。'});
        }
        if(action==='system-disable'){config.systemEnabled=false;saveConfig(config);fs.writeFileSync(path.join(DATA,'system-stop.flag'),'stop');return json(res,{ok:true});}
        if(action==='stop') {fs.writeFileSync(path.join(DATA,'desktop-stop.flag'),'stop');json(res,{ok:true,state:'stopping'});setTimeout(shutdown,200);return;}
        return json(res,{error:'Unsupported action'},400);
      }
      return json(res,{error:'Method not allowed'},405);
    }
    if(req.method!=='GET')return json(res,{error:'Method not allowed'},405);
    const files={'/':'index.html','/app.js':'app.js','/insights.js':'insights.js','/insights.css':'insights.css','/style.css':'style.css','/icon.svg':'icon.svg'};
    const file=files[url.pathname];if(!file)return json(res,{error:'Not found'},404);
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':types[path.extname(file)]+'; charset=utf-8','Cache-Control':'no-cache'});res.end(fs.readFileSync(path.join(ROOT,'public',file)));
  }catch(error){if(!res.headersSent)json(res,{error:error.message},400);else res.end();}
});
const startedAt=new Date().toISOString();
server.on('error',error=>{console.error(JSON.stringify({error:error.code||error.message}));process.exitCode=1;store?.close();});
server.listen(config.port,'127.0.0.1',async()=>{
  try {
    // Acquire the single-instance port before opening/migrating the database.
    // A watchdog retry must never alter the schema of a running older backend.
    store=new Store(path.join(DATA,'traffic.sqlite'));insights=new Insights(store);ai=new AiDiagnostics(store);probes=new NetworkDiagnostics(store);collector=new Collector(store,config);
    const lastHeartbeat=Number(store.getMeta('last_heartbeat_ms')||0);if(lastHeartbeat&&Date.now()-lastHeartbeat>30000)store.event('capture_gap',`采集器未运行时段：${new Date(lastHeartbeat).toISOString()} 至 ${new Date().toISOString()}。该时段不补造流量。`);
    const maintenance=Number(store.getMeta('pending_restart_from_ms')||0);if(maintenance){store.event('capture_gap',`版本维护重载：${new Date(maintenance).toISOString()} 至 ${new Date().toISOString()}，期间可能缺少样本，未补造流量。`);store.setMeta('pending_restart_from_ms','');}
    if(!offline)await collector.start();atomicJSON(path.join(DATA,'server.json'),{pid:process.pid,url:origin,port:config.port,startedAt});
    if(config.systemEnabled){const stop=path.join(DATA,'system-stop.flag');if(fs.existsSync(stop))fs.unlinkSync(stop);recoverSystem();}
    systemRecoveryTimer=setInterval(recoverSystem,30000);systemRecoveryTimer.unref();
    const checkAlert=()=>{try{const globalAlert=evaluateTrafficAlert(store,config);const fresh=insights.evaluateRules(config);if(fresh.length)ruleAlerts=fresh;latestAlert=[globalAlert,latestAlert,...fresh].filter(Boolean).sort((a,b)=>b.time-a.time)[0]||null;if(config.aiDiagnosticsEnabled&&!config.paused&&!offline)ai.scanCodex();}catch(e){store.event('diagnostic_error',e.message);}};checkAlert();alertTimer=setInterval(checkAlert,30000);alertTimer.unref();
    console.log(JSON.stringify({app:'NetScope',url:origin,pid:process.pid}));
  }catch(error){console.error(error.message);await shutdown();}
});
async function shutdown() {if(shuttingDown)return;shuttingDown=true;clearInterval(systemRecoveryTimer);clearInterval(alertTimer);if(collector)await collector.stop();if(store){store.event('stopped','NetScope stopped');store.close();}server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
