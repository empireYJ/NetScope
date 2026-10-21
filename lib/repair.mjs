import {keyOf} from './store.mjs';
import {INTERNAL_NAME} from './accounting.mjs';

// Explicit, reviewed historical flow identities only. Old records did not keep
// the Inner flag, so retain the inference and its evidence rather than invent it.
export function repairInternalAccounting(store,manifest,now=Date.now()) {
  const marker='inner_accounting_repair_'+manifest.id;
  const done=store.getMeta(marker);if(done)return {...JSON.parse(done),alreadyApplied:true};
  if(!manifest.id||!manifest.evidence||!manifest.flows?.length)throw new Error('Reviewed evidence manifest required');
  const db=store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const before=db.prepare('SELECT SUM(up) up,SUM(down) down,COUNT(*) rows FROM traffic').get();
    const flows=manifest.flows.map(expected=>{
      const f=db.prepare('SELECT f.*,a.name,a.path,a.pid FROM flows f JOIN actors a ON a.id=f.actor_id WHERE f.id=?').get(expected.id);
      if(!f||f.name!=='未知程序'||f.pid!==0||f.path||f.source!=='clash'||f.route!=='PROXY'||f.host!==expected.host||f.port!==expected.port||f.chain!==expected.chain||f.protocol!=='TCP')throw new Error('Historical identity mismatch for flow '+expected.id);
      return f;
    });
    if(new Set(flows.map(f=>f.id)).size!==flows.length)throw new Error('Duplicate flow IDs');
    const ids=flows.map(f=>f.id),slots=ids.map(()=>'?').join(',');
    const moved=db.prepare(`SELECT SUM(up) up,SUM(down) down,COUNT(*) rows,MIN(ts) firstMs,MAX(ts) lastMs FROM traffic WHERE flow_id IN (${slots})`).get(...ids);
    const perMinute=db.prepare(`SELECT ts,SUM(up) up,SUM(down) down FROM traffic WHERE flow_id IN (${slots}) GROUP BY ts`).all(...ids);
    const actor=store.actorInsert.get(JSON.stringify([INTERNAL_NAME,'',0,'']),keyOf(INTERNAL_NAME),INTERNAL_NAME,'',0,'',0,'',moved.firstMs,moved.lastMs).id;
    const change=db.prepare("UPDATE flows SET actor_id=?,route='TRANSPORT',identity=?,attribution='historical-proxy-chain-match' WHERE id=?");
    for(const f of flows)change.run(actor,JSON.stringify(['inner-repair',manifest.id,f.id]),f.id);
    const quality=db.prepare('UPDATE quality SET observed_up=MAX(0,observed_up-?),observed_down=MAX(0,observed_down-?),internal_up=internal_up+?,internal_down=internal_down+? WHERE ts=?');
    for(const r of perMinute)quality.run(r.up,r.down,r.up,r.down,r.ts);
    const after=db.prepare('SELECT SUM(up) up,SUM(down) down,COUNT(*) rows FROM traffic').get();
    if(before.up!==after.up||before.down!==after.down||before.rows!==after.rows)throw new Error('Raw byte totals changed');
    let alert;try{alert=JSON.parse(store.getMeta('last_traffic_alert')||'null');}catch{}
    if(alert) {
      const q={route:'PROXY',from:alert.time-3600000,to:alert.time};
      const usage=store.totals(q)[0],top=store.programs({...q,sort:'total',limit:1}).rows[0];
      const totalBytes=(usage?.uploadBytes||0)+(usage?.downloadBytes||0);
      store.setMeta('last_traffic_alert',JSON.stringify({...alert,totalBytes,topProgram:top?.name||'无',topBytes:top?.totalBytes||0,accountingCorrected:true,belowThreshold:totalBytes<alert.thresholdGB*1e9}));
    }
    const report={id:manifest.id,repairedAt:new Date(now).toISOString(),flows:ids,moved,rawBefore:before,rawAfter:after,evidence:manifest.evidence,attribution:'historical-proxy-chain-match',limitation:'旧账本未保留入站类型；按已核对的代理服务器、端口、链路及 PID 0/无路径模式匹配。不是按目标域名猜测应用归属。原始字节及分钟行均保留。'};
    store.setMeta(marker,JSON.stringify(report));
    store.event('accounting_correction',`历史链式代理转发从未知程序移至 TRANSPORT：上传 ${moved.up} 字节，下载 ${moved.down} 字节；原始记录保留，四榜及提醒去重。`,now);
    db.exec('COMMIT');return report;
  }catch(e){db.exec('ROLLBACK');throw e;}
}
