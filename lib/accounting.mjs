export const INTERNAL_NAME='代理核心内部连接';
export const INTERNAL_NOTE='Mihomo Inner 内部连接单独留档。链式代理转发与应用连接可能记录同一批数据，因此不加入四个应用排行榜、应用总量或每小时提醒；转发计数不能与应用流量相加。核心自身的 DNS、更新等内部任务也可能出现在这里，整机网卡仍独立记录实际传输。';
export const isInternal = c => String(c.metadata?.type||c.inboundType||'').toLowerCase()==='inner';
export function connectionVisible(c,query={}) {
  if(query.route&&query.route!=='ALL')return c.route===query.route;
  return c.route!=='TRANSPORT'||String(query.includeTransport)==='true';
}
