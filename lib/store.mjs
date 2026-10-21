import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {INTERNAL_NAME,INTERNAL_NOTE} from './accounting.mjs';

export const keyOf = (name, executable = '') => crypto.createHash('sha256').update((executable || name).toLowerCase()).digest('hex').slice(0, 20);
export const minuteOf = time => Math.floor(time / 60000) * 60000;
export function rangeOf(query = {}, now = Date.now()) {
  const durations = { '1h':3600000, '24h':86400000, '7d':604800000, '30d':2592000000, all:now };
  const parse = (value, fallback) => value === undefined || value === '' ? fallback : /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
  const from=parse(query.from, now - (durations[query.range || 'all'] ?? now));
  const to=parse(query.to, now);
  if(!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<from) throw new Error('Invalid time range');
  return {from:minuteOf(from),to,precisionSeconds:60};
}

export class Store {
  constructor(filename, readOnly=false) {
    if(!readOnly) fs.mkdirSync(path.dirname(filename),{recursive:true});
    this.filename=filename; this.db=new DatabaseSync(filename,{readOnly}); this.db.exec('PRAGMA busy_timeout=5000');
    this.cache=new Map();
    if(readOnly) return;
    this.db.exec(`PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actors(id INTEGER PRIMARY KEY,identity TEXT NOT NULL UNIQUE,program_key TEXT NOT NULL,name TEXT NOT NULL,path TEXT NOT NULL,pid INTEGER NOT NULL,started TEXT NOT NULL,parent_pid INTEGER NOT NULL,parent_name TEXT NOT NULL,first_ms INTEGER NOT NULL,last_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS actors_program ON actors(program_key);
      CREATE TABLE IF NOT EXISTS flows(id INTEGER PRIMARY KEY,identity TEXT NOT NULL UNIQUE,actor_id INTEGER NOT NULL REFERENCES actors(id),host TEXT NOT NULL,ip TEXT NOT NULL,port INTEGER NOT NULL,protocol TEXT NOT NULL,route TEXT NOT NULL,chain TEXT NOT NULL,source TEXT NOT NULL,first_ms INTEGER NOT NULL,last_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS flows_actor ON flows(actor_id);
      CREATE INDEX IF NOT EXISTS flows_route ON flows(route);
      CREATE TABLE IF NOT EXISTS traffic(ts INTEGER NOT NULL,flow_id INTEGER NOT NULL REFERENCES flows(id),up INTEGER NOT NULL CHECK(up>=0),down INTEGER NOT NULL CHECK(down>=0),PRIMARY KEY(ts,flow_id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS traffic_flow_time ON traffic(flow_id,ts);
      CREATE TABLE IF NOT EXISTS physical(ts INTEGER NOT NULL,adapter TEXT NOT NULL,up INTEGER NOT NULL,down INTEGER NOT NULL,PRIMARY KEY(ts,adapter)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS quality(ts INTEGER PRIMARY KEY,global_up INTEGER NOT NULL,global_down INTEGER NOT NULL,observed_up INTEGER NOT NULL,observed_down INTEGER NOT NULL,polls INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,time INTEGER NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_time ON events(time);
      CREATE TABLE IF NOT EXISTS legacy_srum(time INTEGER NOT NULL,app TEXT NOT NULL,up INTEGER NOT NULL,down INTEGER NOT NULL,PRIMARY KEY(time,app)) WITHOUT ROWID;
    `);
    // Keep the accounting layer alongside each normalized flow, so historical
    // records can distinguish missing process attribution from internal relays.
    for(const [table,columns] of Object.entries({flows:{inbound_type:"TEXT NOT NULL DEFAULT ''",attribution:"TEXT NOT NULL DEFAULT ''",rule_type:"TEXT NOT NULL DEFAULT ''",rule_payload:"TEXT NOT NULL DEFAULT ''",remote_destination:"TEXT NOT NULL DEFAULT ''"},quality:{internal_up:'INTEGER NOT NULL DEFAULT 0',internal_down:'INTEGER NOT NULL DEFAULT 0'}})) {
      const existing=new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
      for(const [name,definition] of Object.entries(columns))if(!existing.has(name))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec('PRAGMA user_version=3');this.setMeta('schema_version','3');
    if(!this.getMeta('pid_zero_corrected')) {
      const result=this.db.prepare("UPDATE actors SET name='未知程序',path='',program_key=?,started='',parent_pid=0,parent_name='' WHERE pid=0 AND name='System Idle Process'").run(keyOf('未知程序'));
      if(result.changes)this.event('attribution_correction','Corrected unidentified PID 0 records to unknown program; byte totals retained.');
      this.setMeta('pid_zero_corrected',new Date().toISOString());
    }
    if(!this.getMeta('recording_since')) this.setMeta('recording_since',new Date().toISOString());
    this.actorInsert=this.db.prepare(`INSERT INTO actors(identity,program_key,name,path,pid,started,parent_pid,parent_name,first_ms,last_ms) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET last_ms=MAX(last_ms,excluded.last_ms) RETURNING id`);
    this.flowInsert=this.db.prepare(`INSERT INTO flows(identity,actor_id,host,ip,port,protocol,route,chain,source,first_ms,last_ms,inbound_type,attribution,rule_type,rule_payload,remote_destination) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET last_ms=MAX(last_ms,excluded.last_ms) RETURNING id`);
    this.put=this.db.prepare(`INSERT INTO traffic VALUES(?,?,?,?) ON CONFLICT(ts,flow_id) DO UPDATE SET up=up+excluded.up,down=down+excluded.down`);
  }
  getMeta(key) {return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;}
  setMeta(key,value) {this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));}
  event(kind,detail,time=Date.now()) {this.db.prepare('INSERT INTO events(time,kind,detail) VALUES(?,?,?)').run(time,kind,String(detail).slice(0,1000));}
  append(rows=[],physical=[],quality=[]) {
    const ownsTransaction=!this.db.isTransaction;
    if(ownsTransaction)this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const r of rows) {
        const name=r.name||'未知程序', executable=r.path||'', pid=Number(r.pid)||0, started=r.started||'';
        const actorIdentity=JSON.stringify([name.toLowerCase(),executable.toLowerCase(),pid,started]);
        const actor=this.actorInsert.get(actorIdentity,keyOf(name,executable),name,executable,pid,started,r.parentPid||0,r.parentName||'',r.time,r.time).id;
        const host=r.host||r.ip||'未知目标',ip=r.ip||'',port=Number(r.port)||0,protocol=r.protocol||'',route=r.route||'UNKNOWN',chain=r.chain||'',source=r.source||'clash';
        const inboundType=r.inboundType||'',attribution=r.attribution||'';
        const rule=r.rule||'',rulePayload=r.rulePayload||'',remote=r.remoteDestination||'';
        const identity=JSON.stringify([actor,host,ip,port,protocol,route,chain,source,inboundType,attribution,rule,rulePayload,remote]);
        const flow=this.flowInsert.get(identity,actor,host,ip,port,protocol,route,chain,source,r.time,r.time,inboundType,attribution,rule,rulePayload,remote).id;
        this.put.run(minuteOf(r.time),flow,Math.max(0,Math.round(r.up||0)),Math.max(0,Math.round(r.down||0)));
      }
      const physicalPut=this.db.prepare('INSERT INTO physical VALUES(?,?,?,?) ON CONFLICT(ts,adapter) DO UPDATE SET up=up+excluded.up,down=down+excluded.down');
      for(const r of physical) physicalPut.run(minuteOf(r.time),r.adapter,r.up,r.down);
      const qualityPut=this.db.prepare('INSERT INTO quality(ts,global_up,global_down,observed_up,observed_down,polls,internal_up,internal_down) VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(ts) DO UPDATE SET global_up=global_up+excluded.global_up,global_down=global_down+excluded.global_down,observed_up=observed_up+excluded.observed_up,observed_down=observed_down+excluded.observed_down,internal_up=internal_up+excluded.internal_up,internal_down=internal_down+excluded.internal_down,polls=polls+1');
      for(const r of quality) qualityPut.run(minuteOf(r.time),r.globalUp,r.globalDown,r.observedUp,r.observedDown,r.internalUp||0,r.internalDown||0);
      if(ownsTransaction)this.db.exec('COMMIT');
    }catch(error) {if(ownsTransaction)this.db.exec('ROLLBACK');throw error;}
  }
  filter(query={}) {
    const range=rangeOf(query); const clauses=['t.ts>=?','t.ts<=?']; const args=[range.from,range.to];
    if(query.route && query.route!=='ALL') {if(!['DIRECT','PROXY','UNKNOWN','REJECT','TRANSPORT'].includes(query.route)) throw new Error('Invalid route');clauses.push('f.route=?');args.push(query.route);}
    else if(String(query.includeTransport)!=='true')clauses.push("f.route<>'TRANSPORT'");
    if(query.key) {clauses.push('a.program_key=?');args.push(query.key);}
    if(query.search) {clauses.push('(a.name LIKE ? OR f.host LIKE ?)'); const v='%'+String(query.search).slice(0,150)+'%';args.push(v,v);}
    return {range,sql:clauses.join(' AND '),args};
  }
  totals(query={}) {
    const f=this.filter(query);
    return this.db.prepare(`SELECT f.route,COALESCE(SUM(t.up),0) uploadBytes,COALESCE(SUM(t.down),0) downloadBytes,COUNT(DISTINCT a.program_key) programs,COUNT(DISTINCT f.id) destinations FROM traffic t JOIN flows f ON f.id=t.flow_id JOIN actors a ON a.id=f.actor_id WHERE ${f.sql} GROUP BY f.route`).all(...f.args);
  }
  programs(query={}) {
    const f=this.filter(query); const sort={upload:'uploadBytes',download:'downloadBytes',total:'totalBytes'}[query.sort||'total'];
    if(!sort) throw new Error('Invalid sort');
    const limit=Math.min(1000,Math.max(1,Number(query.limit)||100)),offset=Math.max(0,Number(query.offset)||0);
    const rows=this.db.prepare(`SELECT a.program_key key,MIN(a.name) name,MIN(a.path) path,SUM(t.up) uploadBytes,SUM(t.down) downloadBytes,SUM(t.up+t.down) totalBytes,COUNT(DISTINCT f.host) destinations,COUNT(DISTINCT CASE WHEN a.pid>0 THEN a.id END) processCount,MIN(t.ts) firstMs,MAX(t.ts) lastMs,GROUP_CONCAT(DISTINCT f.route) routes FROM traffic t JOIN flows f ON f.id=t.flow_id JOIN actors a ON a.id=f.actor_id WHERE ${f.sql} GROUP BY a.program_key ORDER BY ${sort} DESC,a.program_key LIMIT ? OFFSET ?`).all(...f.args,limit,offset);
    const total=this.db.prepare(`SELECT COUNT(DISTINCT a.program_key) count FROM traffic t JOIN flows f ON f.id=t.flow_id JOIN actors a ON a.id=f.actor_id WHERE ${f.sql}`).get(...f.args).count;
    return {rows,total,range:f.range,limit,offset};
  }
  details(query={}) {
    if(!query.key) throw new Error('Program key is required'); const f=this.filter(query);
    const summary=this.programs({...query,limit:1}).rows[0];
    const destinations=this.db.prepare(`SELECT f.host,f.ip,f.port,f.protocol,f.route,f.chain,f.source,f.inbound_type inboundType,f.attribution,SUM(t.up) uploadBytes,SUM(t.down) downloadBytes,MIN(t.ts) firstMs,MAX(t.ts) lastMs FROM traffic t JOIN flows f ON f.id=t.flow_id JOIN actors a ON a.id=f.actor_id WHERE ${f.sql} GROUP BY f.host,f.ip,f.port,f.protocol,f.route,f.chain,f.source,f.inbound_type,f.attribution ORDER BY SUM(t.up+t.down) DESC LIMIT 200`).all(...f.args);
    const processes=this.db.prepare(`SELECT a.pid,a.name,a.path,a.started,a.parent_pid parentPid,a.parent_name parentName,SUM(t.up) uploadBytes,SUM(t.down) downloadBytes,MIN(t.ts) firstMs,MAX(t.ts) lastMs FROM traffic t JOIN flows f ON f.id=t.flow_id JOIN actors a ON a.id=f.actor_id WHERE ${f.sql} GROUP BY a.id ORDER BY SUM(t.up+t.down) DESC LIMIT 100`).all(...f.args);
    const taskNote=summary?.name===INTERNAL_NAME?INTERNAL_NOTE:summary?.name==='未知程序'?'已记录流量，但未取得可验证的程序名称或 PID。这是归属缺失的标签，不能据此认定是某个陌生软件；原始目标、路线、来源和时间保留供核对。':'任务详情按进程实例和网络目标归属。同一后台进程内的多个 AI 会话或浏览器标签页，不能仅凭网络计数精确拆分。';
    return {summary,destinations,processes,series:this.series(query),range:f.range,taskNote};
  }
  records(query={}) {
    const f=this.filter(query),limit=Math.min(5000,Math.max(1,Number(query.limit)||500));
    if(query.cursor) {
      let cursor;try{cursor=JSON.parse(Buffer.from(query.cursor,'base64url').toString());}catch{throw new Error('Invalid cursor');}
      if(!Array.isArray(cursor)||cursor.length!==2||!cursor.every(Number.isFinite))throw new Error('Invalid cursor');
      f.sql+=' AND (t.ts>? OR (t.ts=? AND f.id>?))';f.args.push(cursor[0],cursor[0],cursor[1]);
    }
    const rows=this.db.prepare(`SELECT t.ts time,f.id flowId,a.program_key key,a.name,a.path,a.pid,a.started,a.parent_pid parentPid,a.parent_name parentName,f.host,f.ip,f.port,f.protocol,f.route,f.chain,f.source,f.inbound_type inboundType,f.attribution,t.up uploadBytes,t.down downloadBytes FROM traffic t JOIN flows f ON f.id=t.flow_id JOIN actors a ON a.id=f.actor_id WHERE ${f.sql} ORDER BY t.ts,f.id LIMIT ?`).all(...f.args,limit+1);
    const more=rows.length>limit;if(more)rows.pop();const last=rows.at(-1);
    return {rows,range:f.range,nextCursor:more?Buffer.from(JSON.stringify([last.time,last.flowId])).toString('base64url'):null};
  }
  series(query={}) {
    const f=this.filter(query);
    const first=this.db.prepare(`SELECT MIN(t.ts) first FROM traffic t JOIN flows f ON f.id=t.flow_id JOIN actors a ON a.id=f.actor_id WHERE ${f.sql}`).get(...f.args).first;
    const span=f.range.to-Math.max(first??f.range.from,f.range.from);
    const bucket=Math.max(60000,Math.ceil(span/120/60000)*60000);
    const rows=this.db.prepare(`SELECT CAST(t.ts/? AS INTEGER)*? time,f.route,SUM(t.up) uploadBytes,SUM(t.down) downloadBytes FROM traffic t JOIN flows f ON f.id=t.flow_id JOIN actors a ON a.id=f.actor_id WHERE ${f.sql} GROUP BY time,f.route ORDER BY time`).all(bucket,bucket,...f.args);
    return {bucketMs:bucket,rows};
  }
  dashboard(query={}) {
    const rankings={};for(const route of ['DIRECT','PROXY']) for(const sort of ['upload','download']) rankings[`${route.toLowerCase()}_${sort}`]=this.programs({...query,route,sort,limit:5}).rows;
    const range=rangeOf(query);
    const physical=this.db.prepare('SELECT COALESCE(SUM(up),0) uploadBytes,COALESCE(SUM(down),0) downloadBytes FROM physical WHERE ts>=? AND ts<=?').get(range.from,range.to);
    const quality=this.db.prepare('SELECT COALESCE(SUM(global_up),0) globalUp,COALESCE(SUM(global_down),0) globalDown,COALESCE(SUM(observed_up),0) observedUp,COALESCE(SUM(observed_down),0) observedDown,COALESCE(SUM(internal_up),0) internalUp,COALESCE(SUM(internal_down),0) internalDown FROM quality WHERE ts>=? AND ts<=?').get(range.from,range.to);
    const internal=this.totals({...query,route:'TRANSPORT'})[0]||{route:'TRANSPORT',uploadBytes:0,downloadBytes:0,programs:0,destinations:0};
    return {range,totals:this.totals(query),rankings,series:this.series(query),physical,quality,internal,accountingNote:INTERNAL_NOTE,recordingSince:this.getMeta('recording_since')};
  }
  storage() {
    let bytes=0;for(const p of [this.filename,this.filename+'-wal',this.filename+'-shm']) {try {bytes+=fs.statSync(p).size;}catch{}}
    return {bytes,minuteRows:this.db.prepare('SELECT COUNT(*) n FROM traffic').get().n,flowRows:this.db.prepare('SELECT COUNT(*) n FROM flows').get().n,firstMs:this.db.prepare('SELECT MIN(ts) first FROM traffic').get().first,lastMs:this.db.prepare('SELECT MAX(ts) last FROM traffic').get().last};
  }
  cleanup(days, now=Date.now()) {
    if(days===0) return {deletedRows:0,unlimited:true};
    if(!Number.isInteger(days)||days<1||days>3650) throw new Error('retentionDays must be 0 or 1..3650');
    const cutoff=minuteOf(now-days*86400000); let deleted=0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const [table,col] of [['traffic','ts'],['physical','ts'],['quality','ts'],['events','time'],['legacy_srum','time']]) deleted+=Number(this.db.prepare(`DELETE FROM ${table} WHERE ${col}<?`).run(cutoff).changes);
      if(this.insights)deleted+=this.insights.cleanup(cutoff);
      this.db.exec('DELETE FROM flows WHERE NOT EXISTS(SELECT 1 FROM traffic WHERE flow_id=flows.id); DELETE FROM actors WHERE NOT EXISTS(SELECT 1 FROM flows WHERE actor_id=actors.id);');
      this.setMeta('last_cleanup',new Date(now).toISOString());
      this.setMeta('retained_after_ms',Math.max(Number(this.getMeta('retained_after_ms')||0),cutoff));this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.db.exec('PRAGMA incremental_vacuum(2000); PRAGMA wal_checkpoint(PASSIVE);');return {deletedRows:deleted,cutoff};
  }
  importLegacy(filename) {
    if(this.getMeta('legacy_imported')||!fs.existsSync(filename)) return {imported:false};
    const old=new DatabaseSync(filename,{readOnly:true}); old.exec('PRAGMA busy_timeout=5000');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows=old.prepare('SELECT * FROM traffic').all();
      this.append(rows.map(r=>({time:r.minute,name:r.process,path:r.process_path,host:r.host,route:r.route,chain:r.chains,source:'clash-import',up:r.up,down:r.down})));
      const qualityPut=this.db.prepare('INSERT INTO quality(ts,global_up,global_down,observed_up,observed_down,polls) VALUES(?,?,?,?,?,?) ON CONFLICT(ts) DO UPDATE SET global_up=global_up+excluded.global_up,global_down=global_down+excluded.global_down,observed_up=observed_up+excluded.observed_up,observed_down=observed_down+excluded.observed_down,polls=polls+excluded.polls');
      for(const r of old.prepare('SELECT * FROM reconciliation').all())qualityPut.run(r.minute,r.global_up,r.global_down,r.observed_up,r.observed_down,r.polls);
      const since=old.prepare("SELECT value FROM metadata WHERE key='recording_since'").get()?.value;
      if(since) this.setMeta('recording_since',since);
      this.setMeta('legacy_imported',new Date().toISOString());this.event('migration',`Imported ${rows.length} minute records from previous recorder`);
      this.db.exec('COMMIT');
      return {imported:true,rows:rows.length};
    }catch(error){this.db.exec('ROLLBACK');throw error;}finally {old.close();}
  }
  close() {this.db.close();}
}
