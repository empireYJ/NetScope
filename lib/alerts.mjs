export function evaluateTrafficAlert(store,config,now=Date.now()) {
  let previous=null;try{previous=JSON.parse(store.getMeta('last_traffic_alert')||'null');}catch{}
  if(!config.alertEnabled||config.paused||previous&&now-previous.time<3600000)return previous;
  const query={from:now-3600000,to:now,route:'PROXY'};
  const usage=store.totals(query)[0];const total=(usage?.uploadBytes||0)+(usage?.downloadBytes||0);
  if(total<config.alertHourlyGB*1e9)return previous;
  const top=store.programs({...query,sort:'total',limit:1}).rows[0];
  const alert={id:now,time:now,totalBytes:total,thresholdGB:config.alertHourlyGB,topProgram:top?.name||'未知程序',topBytes:top?.totalBytes||0};
  store.setMeta('last_traffic_alert',JSON.stringify(alert));
  store.event('traffic_alert',`最近一小时 VPN 流量 ${(total/1e9).toFixed(2)} GB；最多 ${alert.topProgram}。仅提醒，不中断任务。`,now);
  return alert;
}
