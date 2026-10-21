import crypto from 'node:crypto';

export function diagnosticBundle(store,insights,ai,query={},live={}) {
  const salt=crypto.randomBytes(24),includeHosts=query.includeHosts===true||query.includeHosts==='true';
  const alias=(type,value)=>value?type+'-'+crypto.createHmac('sha256',salt).update(type+':'+value).digest('hex').slice(0,10):'';
  const name=v=>String(v||'').replace(/(?:Bearer\s+\S+|\b(?:sk-|ghp_|github_pat_)[a-zA-Z0-9_-]+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)/gi,'[REDACTED]').slice(0,100);
  const host=v=>includeHosts?name(v):alias('host',v);
  const recordLimit=Math.min(500,Math.max(1,Number(query.limit)||500));
  const records=store.records({...query,limit:recordLimit});
  const trust=insights.trust(query,live),dashboard=store.dashboard(query),metrics=ai.summary(query);
  return {format:'netscope-diagnostic-bundle',version:1,generatedAt:new Date().toISOString(),range:records.range,
    privacy:{hostnamesIncluded:includeHosts,localPaths:false,credentials:false,requestBodies:false,sessionTitles:false,aliasesAreBundleLocal:true},
    collector:{clashOnline:live.clashOnline??false,systemOnline:live.systemOnline??false,paused:live.paused??false,etwLost:live.etwLost??null},
    totals:dashboard.totals,internal:dashboard.internal,
    programs:store.programs({...query,limit:200}).rows.map(r=>({key:alias('program',r.key),name:name(r.name),uploadBytes:r.uploadBytes,downloadBytes:r.downloadBytes,routes:r.routes,processCount:r.processCount})),
    records:records.rows.map(r=>({time:r.time,program:alias('program',r.key),name:name(r.name),host:host(r.host),ip:includeHosts?name(r.ip):alias('ip',r.ip),port:r.port,protocol:r.protocol,route:r.route,source:r.source,inboundType:r.inboundType,attribution:r.attribution,chain:r.chain.split(' → ').filter(Boolean).map(x=>alias('hop',x)),uploadBytes:r.uploadBytes,downloadBytes:r.downloadBytes})),
    recordsTruncated:Boolean(records.nextCursor),recordLimit,
    trust:{unidentifiedBytes:trust.unidentifiedBytes,unidentifiedPercent:trust.unidentifiedPercent,unclassifiedRouteBytes:trust.unclassifiedRouteBytes,clashSamplingPercent:trust.clashSamplingPercent,gaps:trust.gaps,events:trust.events.map(e=>({time:e.time,kind:e.kind})),notes:trust.notes},
    ai:{totals:metrics.totals,note:metrics.note},
    projects:insights.projects(query).rows.map(p=>({project:alias('project',p.id),uploadBytes:p.uploadBytes,downloadBytes:p.downloadBytes,overlappingBytes:p.overlappingBytes})),
    notes:['诊断包是有范围、有条数上限的证据摘要，不是完整抓包。','程序名称保留；本机路径、自由文本事件、会话标题和请求正文不导出。域名默认使用包内稳定别名。','应用、内部转发、整机网卡和 AI 请求正文属于不同口径，不可相加。']};
}
