import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {rangeOf} from './store.mjs';

const digest=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
const integer=(n,nullable=false)=>{if(nullable&&(n===null||n===undefined))return null;if(!Number.isSafeInteger(n)||n<0||n>1e15)throw new Error('Metric sizes/counts must be non-negative safe integers');return n;};
const label=v=>String(v||'未命名请求').replace(/(?:Bearer\s+\S+|\b(?:sk-|ghp_|github_pat_)[a-zA-Z0-9_-]+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)/gi,'[REDACTED]').slice(0,80);

export class AiDiagnostics {
  constructor(store){this.store=store;this.db=store.db;}
  ingest(input) {
    if(!Array.isArray(input)||input.length<1||input.length>100)throw new Error('Supply 1..100 request metrics');
    const rows=input.map(m=>{
      if(!m||typeof m!=='object'||!/^[\w.-]{1,40}$/.test(m.provider||'sdk'))throw new Error('Invalid provider');
      const allowed=new Set(['provider','requestId','time','sessionId','sessionRef','label','preBytes','postBytes','imageBytes','imageCount','attempt','status','evidence','images']);
      if(Object.keys(m).some(k=>!allowed.has(k)))throw new Error('Only request metadata fields are accepted; no bodies, headers or credentials');
      const time=Number(m.time??Date.now());if(!Number.isSafeInteger(time)||time<946684800000||time>Date.now()+300000)throw new Error('Invalid metric time');
      const pre=integer(m.preBytes),post=integer(m.postBytes,true),imageBytes=integer(m.imageBytes,true),imageCount=integer(m.imageCount,true),attempt=integer(m.attempt,true);
      if(imageBytes!==null&&imageBytes>pre)throw new Error('Image encoding bytes exceed complete request');
      if(!Array.isArray(m.images??[] )||(m.images?.length||0)>100)throw new Error('At most 100 unique image hashes per request');
      const seen=new Set();const images=(m.images||[]).map(i=>{if(Object.keys(i).some(k=>!['hash','encodedBytes','occurrences'].includes(k))||!/^[a-f0-9]{64}$/i.test(i.hash)||seen.has(i.hash))throw new Error('Invalid or duplicate image hash');seen.add(i.hash);return {hash:i.hash.toLowerCase(),encodedBytes:integer(i.encodedBytes),occurrences:Math.max(1,integer(i.occurrences??1))};});
      const imageSum=images.reduce((n,i)=>n+i.encodedBytes*i.occurrences,0);if(imageSum>(imageBytes??pre))throw new Error('Image metadata exceeds request image bytes');
      const provider=m.provider||'sdk',sessionRef=m.sessionId?digest(provider+':'+m.sessionId).slice(0,16):m.sessionRef&&/^[a-f0-9]{16}$/.test(m.sessionRef)?m.sessionRef:'unassigned';
      const id=digest(provider+':'+String(m.requestId||JSON.stringify([time,sessionRef,pre,post])));
      const status=['prepared','http-completed','failed','reported'].includes(m.status)?m.status:'reported';
      return {id,time,provider,sessionRef,label:label(m.label||`${provider} · ${sessionRef.slice(0,8)}`),pre,post,imageBytes,imageCount,attempt,status,evidence:m.evidence==='codex-compression-log'?'codex-compression-log':'explicit-metadata-adapter',images};
    });
    this.db.exec('BEGIN IMMEDIATE');let inserted=0;
    try {
      const put=this.db.prepare('INSERT OR IGNORE INTO ai_metrics VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      const imagePut=this.db.prepare('INSERT INTO ai_images VALUES(?,?,?,?)');
      for(const r of rows) {
        const added=put.run(r.id,r.time,r.provider,r.sessionRef,r.label,r.pre,r.post,r.imageBytes,r.imageCount,r.attempt,r.status,r.evidence);
        if(added.changes){inserted++;for(const i of r.images)imagePut.run(r.id,i.hash,i.encodedBytes,i.occurrences);}
      }
      this.db.exec('COMMIT');return {inserted,duplicates:rows.length-inserted};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  scanCodex({filename,now=Date.now(),limit=1000}={}) {
    const file=filename||path.join(process.env.USERPROFILE||'','.codex','logs_2.sqlite');
    if(!fs.existsSync(file))return {available:false,imported:0,note:'本机未找到 Codex 压缩大小日志；可通过元数据 SDK 接入其他工具。'};
    const source=new DatabaseSync(file,{readOnly:true});source.exec('PRAGMA busy_timeout=1500');
    try {
      const max=source.prepare('SELECT MAX(id) id FROM logs').get().id||0;
      const stored=Number(this.store.getMeta('codex_ai_cursor')||0),cursor=stored<=max?stored:0;
      const take=Math.min(2000,Math.max(1,Number(limit)||1000));
      const raw=source.prepare("SELECT id,ts,ts_nanos,thread_id,process_uuid,feedback_log_body FROM logs WHERE id>? AND ts>=? AND target='codex_http_client::request' AND feedback_log_body LIKE '%pre_compression_bytes=%' ORDER BY id LIMIT ?").all(cursor,Math.floor((now-24*3600000)/1000),take);
      const metrics=[];
      for(const r of raw) {
        const match=r.feedback_log_body.match(/pre_compression_bytes=(\d+).*post_compression_bytes=(\d+)/s);if(!match)continue;
        const time=Math.round(r.ts*1000+(r.ts_nanos||0)/1e6);
        // A compression record proves preparation, not completed wire upload.
        metrics.push({provider:'codex',requestId:[r.ts,r.ts_nanos,r.thread_id,r.process_uuid,match[1],match[2]].join(':'),time,sessionId:r.thread_id||'unassigned',preBytes:Number(match[1]),postBytes:Number(match[2]),status:'prepared',evidence:'codex-compression-log'});
      }
      let inserted=0;for(let i=0;i<metrics.length;i+=100)inserted+=this.ingest(metrics.slice(i,i+100)).inserted;
      this.store.setMeta('codex_ai_cursor',raw.at(-1)?.id??max);
      const result={available:true,imported:inserted,examined:raw.length,hasMore:raw.length===take,scannedAt:new Date(now).toISOString(),note:'读取最近 24 小时的请求压缩大小字段；未读取正文、会话标题、附件或认证信息。prepared 不表示上传成功，字节不与网络账本相加。'};
      this.store.setMeta('ai_scan_status',JSON.stringify(result));return result;
    }finally{source.close();}
  }
  summary(query={}) {
    const range=rangeOf(query),args=[range.from,range.to];let where='time BETWEEN ? AND ?';
    if(query.provider){where+=' AND provider=?';args.push(String(query.provider));}
    const totals=this.db.prepare(`SELECT COUNT(*) requests,COALESCE(SUM(pre_bytes),0) preparedBytes,SUM(post_bytes) compressedBytes,SUM(image_bytes) imageBytes,SUM(image_count) imageCount,COUNT(image_bytes) imageMeasuredRequests,COUNT(post_bytes) compressedMeasuredRequests,COUNT(attempt) attemptMeasuredRequests,SUM(CASE WHEN attempt>1 THEN attempt-1 ELSE 0 END) reportedRetries,SUM(CASE WHEN status='http-completed' THEN 1 ELSE 0 END) completedRequests,MAX(post_bytes) largestCompressedBytes FROM ai_metrics WHERE ${where}`).get(...args);
    const sessions=this.db.prepare(`SELECT provider,session_ref sessionRef,MIN(label) label,COUNT(*) requests,SUM(pre_bytes) preparedBytes,SUM(post_bytes) compressedBytes,SUM(image_bytes) imageBytes,COUNT(image_bytes) imageMeasuredRequests,SUM(image_count) imageCount,MIN(time) firstMs,MAX(time) lastMs FROM ai_metrics WHERE ${where} GROUP BY provider,session_ref ORDER BY preparedBytes DESC LIMIT 100`).all(...args);
    const rows=this.db.prepare(`SELECT id,time,provider,session_ref sessionRef,label,pre_bytes preBytes,post_bytes postBytes,image_bytes imageBytes,image_count imageCount,attempt,status,evidence FROM ai_metrics WHERE ${where} ORDER BY time DESC LIMIT 100`).all(...args);
    const repeated=this.db.prepare(`SELECT i.hash,SUM(i.encoded_bytes*i.occurrences) encodedBytes,COUNT(DISTINCT i.metric_id) requests,SUM(i.occurrences) occurrences FROM ai_images i JOIN ai_metrics m ON m.id=i.metric_id WHERE m.${where} GROUP BY i.hash HAVING COUNT(DISTINCT i.metric_id)>1 ORDER BY encodedBytes DESC LIMIT 30`).all(...args);
    const series=this.db.prepare(`SELECT CAST(time/300000 AS INTEGER)*300000 time,SUM(pre_bytes) preBytes,SUM(post_bytes) postBytes,COUNT(*) requests FROM ai_metrics WHERE ${where} GROUP BY 1 ORDER BY 1`).all(...args);
    let scan=null;try{scan=JSON.parse(this.store.getMeta('ai_scan_status')||'null');}catch{}
    return {range,totals,sessions,rows,repeatedImages:repeated.map(r=>({...r,hash:r.hash.slice(0,12)})),series,scan,note:'这里是请求正文元数据，不是机场账单或抓包上传量；不得与应用流量相加。图片与重试未由适配器提供时显示未知。重复图像仅以本地 SHA-256 和编码大小比较，不保存图片或请求正文。'};
  }
}
