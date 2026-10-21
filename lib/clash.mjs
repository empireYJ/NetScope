import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {INTERNAL_NAME,isInternal} from './accounting.mjs';
export function classify(c) {if(isInternal(c))return 'TRANSPORT';const chain=c.chains||[];if(chain.some(x=>/^REJECT(?:-DROP)?$/i.test(x)))return 'REJECT';if(chain.includes('DIRECT'))return 'DIRECT';return chain.length?'PROXY':'UNKNOWN';}
export class Clash {
  constructor() {this.config=null;this.previous=null;this.seen=new Map();this.lastTime=0;}
  reset() {this.previous=null;this.seen.clear();}
  async snapshot() {
    if(!this.config) {
      const config=path.join(process.env.APPDATA,'io.github.clash-verge-rev.clash-verge-rev','clash-verge.yaml');
      const yaml=fs.readFileSync(config,'utf8');const clean=v=>(v||'').trim().replace(/^['"]|['"]$/g,'');
      const socketPath=clean(yaml.match(/^external-controller-pipe:\s*(.+)$/m)?.[1]);
      const secret=clean(yaml.match(/^secret:\s*(.*?)\s*$/m)?.[1]);
      if(!socketPath.startsWith('\\\\.\\pipe\\'))throw new Error('Clash 本地控制管道未配置');this.config={socketPath,secret};
    }
    try{return await new Promise((resolve,reject)=>{
      const req=http.request({socketPath:this.config.socketPath,path:'/connections',method:'GET',headers:{Authorization:'Bearer '+this.config.secret}},res=>{
        let bytes=0;const chunks=[];res.on('data',b=>{bytes+=b.length;if(bytes>32*1024*1024)res.destroy(new Error('snapshot too large'));else chunks.push(b);});res.on('error',reject);
        res.on('end',()=>{if(res.statusCode!==200)return reject(new Error('Clash HTTP '+res.statusCode));try{resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch{reject(new Error('Clash 返回了无效数据'));}});
      });req.on('error',reject);req.setTimeout(3000,()=>req.destroy(new Error('Clash 连接超时')));req.end();
    });}catch(e){this.config=null;throw e;}
  }
  observe(current,time=Date.now()) {
    const reset=this.previous&&(current.uploadTotal<this.previous.uploadTotal||current.downloadTotal<this.previous.downloadTotal);
    const baseline=!this.previous||reset;
    if(baseline) this.seen.clear();
    const result={rows:[],connections:[],baseline,reset:Boolean(reset),globalUp:baseline?0:Math.max(0,current.uploadTotal-this.previous.uploadTotal),globalDown:baseline?0:Math.max(0,current.downloadTotal-this.previous.downloadTotal),observedUp:0,observedDown:0,internalUp:0,internalDown:0,elapsed:Math.max(1,(time-this.lastTime)/1000)};
    for(const c of current.connections||[]) {
      const prior=this.seen.get(c.id);const up=baseline?0:Math.max(0,(c.upload||0)-(prior?.up||0)),down=baseline?0:Math.max(0,(c.download||0)-(prior?.down||0));
      this.seen.set(c.id,{up:c.upload||0,down:c.download||0,time});const m=c.metadata||{};
      const internal=isInternal(c);
      const row={time,name:internal?INTERNAL_NAME:m.process||path.win32.basename(m.processPath||'')||'未知程序',path:internal?'':m.processPath||'',pid:internal?0:Number(m.pid??m.processId)||0,host:m.host||m.destinationIP||'',ip:m.destinationIP||'',port:Number(m.destinationPort)||0,localPort:Number(m.sourcePort)||0,localIP:m.sourceIP||'',protocol:String(m.network||'').toUpperCase(),route:classify(c),chain:(c.chains||[]).join(' → '),source:'clash',inboundType:m.type||'',attribution:internal?'clash-inner':'clash-metadata',up,down};
      Object.assign(row,{rule:c.rule||'',rulePayload:c.rulePayload||'',remoteDestination:m.remoteDestination||''});
      result.connections.push({...row,inboundType:m.type||'',id:c.id,started:c.start,uploadBytes:c.upload||0,downloadBytes:c.download||0,uploadRate:up/result.elapsed,downloadRate:down/result.elapsed});
      if(up||down)result.rows.push(row);
      if(internal){result.internalUp+=up;result.internalDown+=down;}else{result.observedUp+=up;result.observedDown+=down;}
    }
    for(const [id,c] of this.seen)if(time-c.time>120000)this.seen.delete(id);
    this.previous={uploadTotal:current.uploadTotal,downloadTotal:current.downloadTotal};this.lastTime=time;return result;
  }
}
