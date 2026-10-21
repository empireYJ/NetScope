import crypto from 'node:crypto';
import {minuteOf,rangeOf} from './store.mjs';

const uid=()=>crypto.randomUUID();
const number=(v,min,max,label)=>{const n=Number(v);if(!Number.isFinite(n)||n<min||n>max)throw new Error('Invalid '+label);return n;};
const text=(v,max=80)=>String(v??'').trim().slice(0,max);
const safeKey=k=>!k||/^[a-f0-9]{20}$/.test(k);
export function periodWindow(period,now=Date.now()) {
  const d=new Date(now);
  if(period==='hour')return {from:now-3600000,to:now,key:'rolling-hour',cooldown:3600000};
  if(period==='day')d.setHours(0,0,0,0);
  else if(period==='month'){d.setDate(1);d.setHours(0,0,0,0);}
  else throw new Error('Invalid period');
  return {from:d.getTime(),to:now,key:String(d.getTime()),cooldown:0};
}
export function explainRoute(r) {
  const internal=r.route==='TRANSPORT',chains=String(r.chain||'').split(' → ').filter(Boolean);
  return {...r,layer:internal?'internal':'application',includedInApplicationTotals:!internal,
    steps:[{kind:'application',label:r.name||'未知程序',evidence:r.pid?'PID '+r.pid:r.attribution||'进程未确认'},
      {kind:'inbound',label:r.inboundType||'历史未保存入站类型'},
      {kind:'rule',label:r.rule||'历史未保存命中规则',value:r.rulePayload||''},
      ...chains.slice().reverse().map(label=>({kind:'hop',label})),
      {kind:'destination',label:r.host||r.ip||'未知目标',value:r.port?String(r.port):''}],
    confidence:r.source==='windows-etw'?'Windows 路由证据':r.rule?'Clash 实时规则证据':r.attribution==='historical-proxy-chain-match'?'历史代理端点与链路匹配':'仅保留路线与链路，不能反推当时的具体规则',
    note:internal?'内部层可能与应用流量重叠，独立留档，不与应用字节相加。':'代理链按 Clash 返回的目标侧链路反向展示为应用到出口的顺序；不代表每一跳的独立计费。'};
}

export class Insights {
  constructor(store) {
    this.store=store;this.db=store.db;store.insights=this;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS process_sessions(pid INTEGER NOT NULL,started TEXT NOT NULL,name TEXT NOT NULL,path TEXT NOT NULL,parent_pid INTEGER NOT NULL,parent_started TEXT NOT NULL,first_ms INTEGER NOT NULL,last_ms INTEGER NOT NULL,ended_ms INTEGER,PRIMARY KEY(pid,started)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS process_session_time ON process_sessions(last_ms);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL,created_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS project_rules(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,kind TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alert_rules(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,program_key TEXT NOT NULL,route TEXT NOT NULL,direction TEXT NOT NULL,period TEXT NOT NULL,limit_bytes INTEGER NOT NULL,factor REAL NOT NULL,enabled INTEGER NOT NULL,created_ms INTEGER NOT NULL,state TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS rule_notifications(id TEXT PRIMARY KEY,rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,time INTEGER NOT NULL,occurrence TEXT NOT NULL,detail TEXT NOT NULL,UNIQUE(rule_id,occurrence));
      CREATE INDEX IF NOT EXISTS notifications_time ON rule_notifications(time);
      CREATE TABLE IF NOT EXISTS network_probes(id TEXT PRIMARY KEY,time INTEGER NOT NULL,host TEXT NOT NULL,port INTEGER NOT NULL,mode TEXT NOT NULL,result TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS probes_time ON network_probes(time);
      CREATE TABLE IF NOT EXISTS ai_metrics(id TEXT PRIMARY KEY,time INTEGER NOT NULL,provider TEXT NOT NULL,session_ref TEXT NOT NULL,label TEXT NOT NULL,pre_bytes INTEGER NOT NULL,post_bytes INTEGER,image_bytes INTEGER,image_count INTEGER,attempt INTEGER,status TEXT NOT NULL,evidence TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_metric_time ON ai_metrics(time);
      CREATE TABLE IF NOT EXISTS ai_images(metric_id TEXT NOT NULL REFERENCES ai_metrics(id) ON DELETE CASCADE,hash TEXT NOT NULL,encoded_bytes INTEGER NOT NULL,occurrences INTEGER NOT NULL,PRIMARY KEY(metric_id,hash)) WITHOUT ROWID;
    `);
  }
  cleanup(cutoff) {
    let deleted=0;
    for(const [table,column] of [['process_sessions','last_ms'],['rule_notifications','time'],['network_probes','time'],['ai_metrics','time']])deleted+=Number(this.db.prepare(`DELETE FROM ${table} WHERE ${column}<?`).run(cutoff).changes);
    return deleted;
  }
  recordProcesses(processes,time=Date.now()) {
    const map=new Map(processes.map(p=>[p.pid,p]));
    const put=this.db.prepare(`INSERT INTO process_sessions VALUES(?,?,?,?,?,?,?,?,NULL) ON CONFLICT(pid,started) DO UPDATE SET last_ms=excluded.last_ms,ended_ms=NULL,parent_started=CASE WHEN excluded.parent_started<>'' THEN excluded.parent_started ELSE parent_started END WHERE excluded.last_ms-last_ms>=60000 OR ended_ms IS NOT NULL OR parent_started<>excluded.parent_started`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const p of processes)if(p.pid>0&&p.started&&Number.isFinite(Date.parse(p.started)))put.run(p.pid,p.started,p.name||'',p.path||'',p.parentPid||0,map.get(p.parentPid)?.started||'',time,time);
      this.db.prepare('UPDATE process_sessions SET ended_ms=? WHERE ended_ms IS NULL AND last_ms<?').run(time,time-120000);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  flowRows(query={}) {
    const f=this.store.filter(query);
    return this.db.prepare(`SELECT f.id flowId,a.id actorId,a.program_key key,a.name,a.path,a.pid,a.started,a.parent_pid parentPid,a.parent_name parentName,f.host,f.ip,f.port,f.protocol,f.route,f.chain,f.source,f.inbound_type inboundType,f.attribution,f.rule_type rule,f.rule_payload rulePayload,f.remote_destination remoteDestination,SUM(t.up) uploadBytes,SUM(t.down) downloadBytes,MIN(t.ts) firstMs,MAX(t.ts) lastMs FROM traffic t JOIN flows f ON f.id=t.flow_id JOIN actors a ON a.id=f.actor_id WHERE ${f.sql} GROUP BY f.id ORDER BY SUM(t.up+t.down) DESC`).all(...f.args);
  }
  peaks(query={}) {
    const f=this.store.filter(query),sort={upload:'SUM(t.up)',download:'SUM(t.down)',total:'SUM(t.up+t.down)'}[query.sort||'upload'];
    if(!sort)throw new Error('Invalid sort');
    const rows=this.db.prepare(`SELECT t.ts time,SUM(t.up) uploadBytes,SUM(t.down) downloadBytes,COUNT(DISTINCT a.program_key) programs FROM traffic t JOIN flows f ON f.id=t.flow_id JOIN actors a ON a.id=f.actor_id WHERE ${f.sql} GROUP BY t.ts ORDER BY ${sort} DESC LIMIT ?`).all(...f.args,Math.floor(Math.min(100,Math.max(1,Number(query.limit)||12))));
    return {range:f.range,rows,note:'峰值为已保存的分钟累计，不是瞬时网速。点击回溯该分钟及邻近事件。'};
  }
  replay(query={}) {
    let q={...query};
    if(query.at!==undefined){const at=/^\d+$/.test(String(query.at))?Number(query.at):Date.parse(query.at);if(!Number.isFinite(at))throw new Error('Invalid replay time');const span=number(query.minutes||5,1,60,'replay span');q.from=Math.max(0,minuteOf(at)-Math.floor(span/2)*60000);q.to=minuteOf(at)+(Math.ceil(span/2))*60000-1;}
    const range=rangeOf(q);if(range.to-range.from>7*86400000)throw new Error('Replay window must be at most 7 days');
    const flows=this.flowRows(q);
    const processes=new Map();for(const r of flows){let p=processes.get(r.actorId);if(!p){p={actorId:r.actorId,key:r.key,name:r.name,pid:r.pid,started:r.started,parentPid:r.parentPid,parentName:r.parentName,firstMs:r.firstMs,lastMs:r.lastMs,uploadBytes:0,downloadBytes:0};processes.set(r.actorId,p);}p.uploadBytes+=r.uploadBytes;p.downloadBytes+=r.downloadBytes;p.firstMs=Math.min(p.firstMs,r.firstMs);p.lastMs=Math.max(p.lastMs,r.lastMs);}
    const events=this.db.prepare('SELECT time,kind,detail FROM events WHERE time BETWEEN ? AND ? ORDER BY time LIMIT 200').all(range.from,range.to);
    return {range,totals:this.store.totals(q),series:this.store.series(q),processes:[...processes.values()].sort((a,b)=>b.uploadBytes-a.uploadBytes).slice(0,100),flows:flows.slice(0,100),flowCount:flows.length,truncated:flows.length>100,events,note:'进程实例和目标为实测关联；不能仅凭同一 PID 把网络字节分摊到应用内的不同会话。'};
  }
  compare(query={}) {
    const current=rangeOf(query);if(current.to-current.from>31*86400000)throw new Error('Comparison window must be at most 31 days');
    const span=Math.max(60000,current.to-current.from);
    const previous=rangeOf({from:query.baselineFrom??Math.max(0,current.from-span),to:query.baselineTo??current.from-1});
    const aggregate=q=>{const map=new Map();for(const r of this.flowRows(q)){let v=map.get(r.key)||{key:r.key,name:r.name,uploadBytes:0,downloadBytes:0};v.uploadBytes+=r.uploadBytes;v.downloadBytes+=r.downloadBytes;map.set(r.key,v);}return map;};
    const now=aggregate({...query,...current}),old=aggregate({...query,...previous});
    const rows=[...new Set([...now.keys(),...old.keys()])].map(key=>{const a=now.get(key),b=old.get(key);return {key,name:a?.name||b.name,currentUpload:a?.uploadBytes||0,baselineUpload:b?.uploadBytes||0,uploadDelta:(a?.uploadBytes||0)-(b?.uploadBytes||0),currentDownload:a?.downloadBytes||0,baselineDownload:b?.downloadBytes||0,downloadDelta:(a?.downloadBytes||0)-(b?.downloadBytes||0)};}).sort((a,b)=>Math.abs(b.uploadDelta)-Math.abs(a.uploadDelta));
    return {current,baseline:previous,rows:rows.slice(0,200),programCount:rows.length,truncated:rows.length>200,note:'默认与紧邻的等长前一时段比较。正值表示增加；零基线不计算百分比。'};
  }
  routes(query={}) {const rows=this.flowRows(query);const limit=Math.floor(Math.min(500,Math.max(1,Number(query.limit)||100)));return {range:rangeOf(query),rows:rows.slice(0,limit).map(explainRoute),total:rows.length,truncated:rows.length>limit};}
  route(flowId) {
    const id=number(flowId,1,Number.MAX_SAFE_INTEGER,'flow id');
    const r=this.db.prepare(`SELECT f.id flowId,a.program_key key,a.name,a.pid,f.host,f.ip,f.port,f.protocol,f.route,f.chain,f.source,f.inbound_type inboundType,f.attribution,f.rule_type rule,f.rule_payload rulePayload,f.remote_destination remoteDestination FROM flows f JOIN actors a ON a.id=f.actor_id WHERE f.id=?`).get(id);
    if(!r)throw new Error('Flow no longer retained');return explainRoute(r);
  }
  trust(query={},live={}) {
    const f=this.store.filter(query);
    const counts=this.db.prepare(`SELECT COALESCE(SUM(t.up+t.down),0) totalBytes,COALESCE(SUM(CASE WHEN a.name='未知程序' OR a.name LIKE 'PID %' THEN t.up+t.down ELSE 0 END),0) unidentifiedBytes,COALESCE(SUM(CASE WHEN a.pid=0 AND a.name<>'未知程序' THEN t.up+t.down ELSE 0 END),0) nameOnlyBytes,COALESCE(SUM(CASE WHEN f.route='UNKNOWN' THEN t.up+t.down ELSE 0 END),0) unclassifiedRouteBytes FROM traffic t JOIN flows f ON f.id=t.flow_id JOIN actors a ON a.id=f.actor_id WHERE ${f.sql}`).get(...f.args);
    const from=Math.max(f.range.from,Date.parse(this.store.getMeta('recording_since'))||0,Number(this.store.getMeta('retained_after_ms')||0)),to=Math.min(f.range.to,Date.now());
    const minutes=this.db.prepare('SELECT ts,polls FROM quality WHERE ts BETWEEN ? AND ? ORDER BY ts').all(minuteOf(from),to);
    const gaps=[];let cursor=minuteOf(from);for(const r of minutes){if(r.ts>cursor)gaps.push({from:cursor,to:r.ts-1,kind:'clash_no_samples'});cursor=r.ts+60000;}if(cursor+60000<=to)gaps.push({from:cursor,to:minuteOf(to)-1,kind:'clash_no_samples'});
    const expected=Math.max(0,Math.floor((to-from)/1000));const polls=minutes.reduce((n,r)=>n+r.polls,0);
    const events=this.db.prepare("SELECT time,kind,detail FROM events WHERE time BETWEEN ? AND ? AND kind IN ('coverage_gap','capture_gap','collector_error','sensor_error','accounting_correction','attribution_correction','paused','resumed') ORDER BY time DESC LIMIT 100").all(f.range.from,f.range.to);
    return {range:f.range,effectiveCoverageFrom:from,...counts,unidentifiedPercent:counts.totalBytes?counts.unidentifiedBytes/counts.totalBytes*100:0,routeUnknownPercent:counts.totalBytes?counts.unclassifiedRouteBytes/counts.totalBytes*100:0,clashSamples:polls,expectedSeconds:expected,clashSamplingPercent:expected?Math.min(100,polls/expected*100):null,gaps:gaps.slice(-100),gapCount:gaps.length,events,internal:this.store.totals({...query,route:'TRANSPORT'})[0]||null,live:{clashOnline:live.clashOnline??false,systemOnline:live.systemOnline??false,etwLost:live.etwLost??null,paused:live.paused??false},storage:this.store.storage(),notes:['采样覆盖率描述 Clash 的采样机会，不是整机流量完整率。暂停或离线均可产生无样本时段。','已按保留期限清理的时段不标为采集缺口。','未知归属和未知路线是两个独立维度，不能相加为一个丢失百分比。','内部转发和物理网卡分别留档，不与应用总量叠加。旧记录缺少的规则不反向猜测。']};
  }
  createProject(value) {
    if(this.db.prepare('SELECT COUNT(*) n FROM projects').get().n>=200)throw new Error('最多保留 200 个项目分组');
    const name=text(value.name);if(!name)throw new Error('Project name required');
    const color=/^#[a-f0-9]{6}$/i.test(value.color||'')?value.color:'#b1f86a',id=uid();
    this.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(id,name,color,Date.now());return {id,name,color};
  }
  deleteProject(id){this.db.prepare('DELETE FROM projects WHERE id=?').run(String(id));return {ok:true};}
  addProjectRule(id,value) {
    if(!this.db.prepare('SELECT id FROM projects WHERE id=?').get(id))throw new Error('Project not found');
    const kind=value.kind;let v;
    if(kind==='program'){v=text(value.value,20);if(!v||!safeKey(v))throw new Error('Invalid program key');}
    else if(kind==='domain'){v=text(value.value,253).toLowerCase();if(!/^[a-z0-9_.:-]+$/.test(v))throw new Error('Invalid domain');}
    else if(kind==='process-tree'){const p=value.value;if(!p||!Number.isInteger(p.pid)||p.pid<1||!Number.isFinite(Date.parse(p.started)))throw new Error('PID and exact process start time required');v=JSON.stringify({pid:p.pid,started:p.started});}
    else throw new Error('Invalid project rule kind');
    const existing=this.db.prepare('SELECT id FROM project_rules WHERE project_id=? AND kind=? AND value=?').get(id,kind,v);if(existing)return {id:existing.id,projectId:id,kind,value:v};
    if(this.db.prepare('SELECT COUNT(*) n FROM project_rules').get().n>=2000)throw new Error('最多保留 2000 条项目匹配规则');
    const rule={id:uid(),projectId:id,kind,value:v};this.db.prepare('INSERT INTO project_rules VALUES(?,?,?,?)').run(rule.id,id,kind,v);return rule;
  }
  deleteProjectRule(id){this.db.prepare('DELETE FROM project_rules WHERE id=?').run(String(id));return {ok:true};}
  projects(query={}) {
    const projects=this.db.prepare('SELECT id,name,color,created_ms createdMs FROM projects ORDER BY created_ms').all();
    const rules=this.db.prepare('SELECT id,project_id projectId,kind,value FROM project_rules').all();
    const sessions=new Map(this.db.prepare('SELECT pid,started,parent_pid,parent_started FROM process_sessions').all().map(p=>[p.pid+'@'+p.started,p]));
    const descendants=(r,v)=>{let key=r.pid+'@'+r.started;const root=v.pid+'@'+v.started,seen=new Set();for(let i=0;i<64&&key&&!seen.has(key);i++){if(key===root)return true;seen.add(key);const p=sessions.get(key);if(!p?.parent_started)return false;key=p.parent_pid+'@'+p.parent_started;}return false;};
    const compiled=rules.map(r=>({...r,parsed:r.kind==='process-tree'?JSON.parse(r.value):r.value}));
    const rows=this.flowRows(query);let unassignedBytes=0,overlappingBytes=0;
    const output=projects.map(p=>({...p,rules:rules.filter(r=>r.projectId===p.id),uploadBytes:0,downloadBytes:0,actors:new Map(),destinations:new Set(),overlappingBytes:0}));
    for(const row of rows) {
      const matched=output.filter(p=>compiled.some(rule=>rule.projectId===p.id&&(rule.kind==='program'?row.key===rule.parsed:rule.kind==='domain'?row.host.toLowerCase()===rule.parsed||row.host.toLowerCase().endsWith('.'+rule.parsed):descendants(row,rule.parsed))));
      if(!matched.length)unassignedBytes+=row.uploadBytes+row.downloadBytes;
      if(matched.length>1)overlappingBytes+=row.uploadBytes+row.downloadBytes;
      for(const p of matched){p.uploadBytes+=row.uploadBytes;p.downloadBytes+=row.downloadBytes;p.destinations.add(row.host);let a=p.actors.get(row.actorId)||{pid:row.pid,started:row.started,name:row.name,key:row.key,uploadBytes:0,downloadBytes:0};a.uploadBytes+=row.uploadBytes;a.downloadBytes+=row.downloadBytes;p.actors.set(row.actorId,a);if(matched.length>1)p.overlappingBytes+=row.uploadBytes+row.downloadBytes;}
    }
    return {range:rangeOf(query),rows:output.map(p=>({...p,actors:[...p.actors.values()].sort((a,b)=>b.uploadBytes-a.uploadBytes).slice(0,100),destinations:[...p.destinations].slice(0,100)})),unassignedBytes,overlappingBytes,note:'按显式规则归组。程序路径规则包含该程序所有实例；进程树规则绑定 PID + 创建时间并依赖保留的父进程生命周期证据。多个项目命中时明确标注重叠，不把项目总量再相加。'};
  }
  validateRule(v,old={}) {
    const r={...old,...v};r.name=text(r.name);if(!r.name)throw new Error('Rule name required');
    if(!['budget','spike','new-program','new-destination'].includes(r.kind))throw new Error('Invalid rule kind');
    r.programKey=r.programKey||'';if(!safeKey(r.programKey))throw new Error('Invalid program key');
    r.route=r.route||'PROXY';if(!['PROXY','DIRECT','ALL'].includes(r.route))throw new Error('Invalid rule route');
    r.direction=r.direction||'total';if(!['upload','download','total'].includes(r.direction))throw new Error('Invalid direction');
    r.period=r.period||'hour';periodWindow(r.period);r.limitBytes=Math.round(number(r.limitBytes??1e9,1,1e15,'budget bytes'));
    r.factor=number(r.factor??3,1.1,100,'spike factor');if(r.enabled!==undefined&&typeof r.enabled!=='boolean')throw new Error('enabled must be boolean');r.enabled=r.enabled??true;return r;
  }
  saveRule(value,id) {
    if(!id&&this.db.prepare('SELECT COUNT(*) n FROM alert_rules').get().n>=100)throw new Error('最多保留 100 条提醒规则');
    const old=id?this.db.prepare('SELECT * FROM alert_rules WHERE id=?').get(id):null;if(id&&!old)throw new Error('Rule not found');
    const previous=old?{name:old.name,kind:old.kind,programKey:old.program_key,route:old.route,direction:old.direction,period:old.period,limitBytes:old.limit_bytes,factor:old.factor,enabled:Boolean(old.enabled)}:{};
    const r=this.validateRule(value,previous);const ruleId=id||uid();
    this.db.prepare(`INSERT INTO alert_rules(id,name,kind,program_key,route,direction,period,limit_bytes,factor,enabled,created_ms,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,'{}') ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,program_key=excluded.program_key,route=excluded.route,direction=excluded.direction,period=excluded.period,limit_bytes=excluded.limit_bytes,factor=excluded.factor,enabled=excluded.enabled,state='{}',created_ms=excluded.created_ms`).run(ruleId,r.name,r.kind,r.programKey,r.route,r.direction,r.period,r.limitBytes,r.factor,r.enabled?1:0,Date.now());
    return {id:ruleId,...r};
  }
  deleteRule(id){this.db.prepare('DELETE FROM alert_rules WHERE id=?').run(String(id));return {ok:true};}
  rules(now=Date.now()) {
    return {timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,rows:this.db.prepare('SELECT * FROM alert_rules ORDER BY created_ms').all().map(r=>{const window=periodWindow(r.period,now),q={...window,route:r.route,...(r.program_key?{key:r.program_key}:{})};const t=this.store.totals(q);const usage=t.reduce((n,x)=>n+(r.direction==='upload'?x.uploadBytes:r.direction==='download'?x.downloadBytes:x.uploadBytes+x.downloadBytes),0);return {id:r.id,name:r.name,kind:r.kind,programKey:r.program_key,route:r.route,direction:r.direction,period:r.period,limitBytes:r.limit_bytes,factor:r.factor,enabled:Boolean(r.enabled),createdMs:r.created_ms,usageBytes:usage,window,progress:r.kind==='budget'?usage/r.limit_bytes:null};}),notifications:this.db.prepare('SELECT id,rule_id ruleId,time,detail FROM rule_notifications ORDER BY time DESC LIMIT 50').all().map(r=>({...r,detail:JSON.parse(r.detail)})),note:'所有规则只提醒，不断网、不限速。小时为滚动窗口，日/月按本机时区；新程序/新目标以保留账本内的首次活动为依据。'};
  }
  evaluateRules(config,now=Date.now()) {
    if(config.paused||!config.alertEnabled)return [];
    const alerts=[];
    for(const r of this.db.prepare('SELECT * FROM alert_rules WHERE enabled=1').all()) {
      const state=JSON.parse(r.state||'{}'),window=periodWindow(r.period,now),q={route:r.route,...(r.program_key?{key:r.program_key}:{})};
      const volume=(from,to)=>this.store.totals({...q,from,to}).reduce((n,x)=>n+(r.direction==='upload'?x.uploadBytes:r.direction==='download'?x.downloadBytes:x.uploadBytes+x.downloadBytes),0);
      let occurrence,bytes=0,message,topProgram='';
      if(r.kind==='budget') {bytes=volume(window.from,now);if(bytes<r.limit_bytes)continue;occurrence=window.cooldown?'hour-'+Math.floor(now/3600000):window.key;if(state.lastMs&&(window.cooldown?now-state.lastMs<window.cooldown:state.key===window.key))continue;message=`预算“${r.name}”已记录 ${(bytes/1e9).toFixed(3)} GB，达到 ${(r.limit_bytes/1e9).toFixed(3)} GB。`;}
      else if(r.kind==='spike') {const end=minuteOf(now);bytes=volume(end,now);const baseline=volume(Math.max(0,end-15*60000),end-1)/15;if(bytes<r.limit_bytes||baseline<=0||bytes<baseline*r.factor||state.lastMs&&now-state.lastMs<3600000)continue;occurrence='spike-'+end;message=`“${r.name}”本分钟已记录 ${(bytes/1e6).toFixed(1)} MB，达到此前 15 分钟均值的 ${(bytes/baseline).toFixed(1)} 倍。`;}
      else {
        const where=this.store.filter({...q,from:r.created_ms,to:now});
        const group=r.kind==='new-program'?'a.program_key':'a.program_key,f.host';
        const found=this.db.prepare(`SELECT a.program_key key,MIN(a.name) name,f.host,MIN(f.first_ms) firstMs,SUM(t.up+t.down) bytes FROM traffic t JOIN flows f ON f.id=t.flow_id JOIN actors a ON a.id=f.actor_id WHERE ${where.sql} GROUP BY ${group} HAVING MIN(f.first_ms)>=? ORDER BY firstMs LIMIT 100`).all(...where.args,r.created_ms);
        for(const x of found){const earliest=this.db.prepare(`SELECT MIN(f.first_ms) first FROM flows f JOIN actors a ON a.id=f.actor_id WHERE a.program_key=? ${r.kind==='new-destination'?'AND f.host=?':''} AND f.route<>'TRANSPORT'`).get(x.key,...(r.kind==='new-destination'?[x.host]:[])).first;if(earliest<r.created_ms)continue;const key=r.kind+':'+x.key+(r.kind==='new-destination'?':'+x.host:'');if(this.db.prepare('SELECT id FROM rule_notifications WHERE rule_id=? AND occurrence=?').get(r.id,key))continue;occurrence=key;bytes=x.bytes;topProgram=x.name;message=`“${r.name}”：${x.name}${r.kind==='new-destination'?' 首次连接 '+x.host:' 首次产生网络活动'}。`;break;}
        if(!occurrence)continue;
      }
      const alert={id:now+alerts.length,time:now,ruleId:r.id,kind:r.kind,title:'墨流 · '+r.name,message:message+' 仅提醒，联网任务继续。',totalBytes:bytes,topProgram:topProgram||r.name,topBytes:bytes,thresholdGB:r.limit_bytes/1e9};
      const inserted=this.db.prepare('INSERT OR IGNORE INTO rule_notifications VALUES(?,?,?,?,?)').run(uid(),r.id,now,occurrence,JSON.stringify(alert));
      if(inserted.changes){alerts.push(alert);this.db.prepare('UPDATE alert_rules SET state=? WHERE id=?').run(JSON.stringify({lastMs:now,key:window.key}),r.id);this.store.event('rule_alert',alert.message,now);}
    }
    return alerts;
  }
}
