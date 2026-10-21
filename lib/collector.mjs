import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {Clash} from './clash.mjs';
import {ROOT,DATA} from './config.mjs';
import {keyOf} from './store.mjs';

export {SENSOR_PIPE} from './identity.mjs';
import {SENSOR_PIPE} from './identity.mjs';
const corePattern=/^(verge-mihomo|mihomo|clash(?:-meta)?|clash-verge|sing-box)\.exe$/i;
export function extraRoute(flow,physicalIndices,physicalAddresses,matched,program,clashSourceAddresses=new Set()) {
  if(corePattern.test(program)) return 'TRANSPORT';
  if(matched) return 'DUPLICATE';
  if(physicalIndices.has(flow.routeIndex)&&physicalAddresses.has(flow.local)&&!/^198\.(18|19)\./.test(flow.remote)) return 'DIRECT';
  // Explicit physical binding may bypass the default TUN route. Only supplement
  // when observed Clash connections use a distinct set of source addresses.
  if(physicalAddresses.has(flow.local)&&clashSourceAddresses.size>0&&![...clashSourceAddresses].some(a=>physicalAddresses.has(a))&&!/^198\.(18|19)\./.test(flow.remote))return 'DIRECT';
  return 'UNKNOWN';
}
export class Collector {
  constructor(store,config) {
    this.store=store;this.config=config;this.clash=new Clash();this.stopping=false;this.rows=[];this.physical=[];this.quality=[];
    this.processes=new Map();this.sockets=new Map();this.matches=new Map();this.interfaces=[];this.nicPrevious=new Map();this.nativePending=[];
    this.live=[];this.points=[];this.etwLive=new Map();this.physicalRates={up:0,down:0};this.lastFlush=0;this.lastCleanup=0;this.lastClash=0;
    this.status={clashOnline:false,sensorOnline:false,systemOnline:false,lastSampleAt:null,systemLastAt:null,etwLost:0,samples:0,error:null,systemError:null};
  }
  enrich(r) {
    if(r.route==='TRANSPORT')return {...r,started:r.started||'',parentPid:0,parentName:'',key:keyOf(r.name,r.path)};
    const ids=this.sockets.get(`${r.protocol}:${r.localPort}`)||[];
    if(!r.pid) {const match=ids.map(id=>this.processes.get(id)).find(p=>p?.name?.toLowerCase()===r.name?.toLowerCase());r.pid=match?.pid||(ids.length===1?ids[0]:0);}
    const proc=r.pid>0?this.processes.get(r.pid):undefined;const parent=proc?.parentPid>0?this.processes.get(proc.parentPid):undefined;
    return {...r,name:r.name==='未知程序'?(proc?.name||r.name):r.name,path:r.path||proc?.path||'',started:proc?.started||'',connectionStarted:r.connectionStarted||r.started||'',attribution:proc?(r.name==='未知程序'?'socket-owner':'clash-metadata+socket-owner'):r.attribution||'unresolved',parentPid:proc?.parentPid||0,parentName:parent?.name||'',key:keyOf(r.name==='未知程序'?(proc?.name||r.name):r.name,r.path||proc?.path||'')};
  }
  receive(message) {
    if(message.type==='interfaces') {
      this.interfaces=message.interfaces;this.status.sensorOnline=true;this.status.sensorLastAt=message.time;let up=0,down=0;
      for(const nic of this.interfaces.filter(n=>n.physical&&n.online)) {
        const prev=this.nicPrevious.get(nic.index);this.nicPrevious.set(nic.index,{up:nic.up,down:nic.down,time:message.time});
        if(prev&&!this.config.paused) {
          const du=Math.max(0,nic.up-prev.up),dd=Math.max(0,nic.down-prev.down),seconds=Math.max(0.1,(message.time-prev.time)/1000);
          this.physical.push({time:message.time,adapter:nic.name,up:du,down:dd});up+=du/seconds;down+=dd/seconds;
        }
      }
      this.physicalRates={up,down};
    }
    if(message.type==='processes') {this.processes=new Map(message.processes.map(p=>[p.pid,p]));if(!this.config.paused)this.store.insights?.recordProcesses(message.processes,message.time);}
    if(message.type==='sockets') {this.sockets.clear();for(const s of message.sockets) {const key=`${s.protocol}:${s.localPort}`,ids=this.sockets.get(key)||[];if(!ids.includes(s.pid))ids.push(s.pid);this.sockets.set(key,ids);}}
    if(message.type==='ready'&&message.etw) {this.status.systemOnline=true;this.status.systemError=null;this.store.event('system_sensor','Windows network event capture started');}
    if(message.type==='network') {
      this.status.systemOnline=true;this.status.systemLastAt=message.time;this.status.etwLost=message.lost;
      if(!this.config.paused)this.nativePending.push(message);
    }
    if(message.type==='error') {this.status.systemError=message.message;this.store.event('sensor_error',message.message);}
  }
  async start() {
    this.pipe=net.createServer(socket=>{
      let buffer='';socket.setEncoding('utf8');socket.on('data',chunk=>{
        buffer+=chunk;if(buffer.length>16*1024*1024){socket.destroy();return;}
        let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{this.receive(JSON.parse(line));}catch{}}
      });socket.on('error',()=>{});socket.on('close',()=>{this.status.systemOnline=false;});
    });
    await new Promise((resolve,reject)=>{this.pipe.once('error',reject);this.pipe.listen('\\\\.\\pipe\\'+SENSOR_PIPE,resolve);});
    this.startInfo();this.loopTask=this.loop().catch(e=>{this.status.error='采集停止: '+e.message;this.status.clashOnline=false;this.status.systemOnline=false;this.store.event('collector_error',e.message);});
  }
  startInfo() {
    if(this.stopping)return;
    const exe=path.join(ROOT,'runtime','sensor','NetScope.Sensor.exe');
    if(!fs.existsSync(exe)){this.status.error='系统采集器尚未编译';return;}
    this.child=spawn(exe,[],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    readline.createInterface({input:this.child.stdout}).on('line',line=>{try{this.receive(JSON.parse(line));}catch{}});
    this.child.stderr.on('data',()=>{});this.child.on('error',e=>{this.status.error=e.message;});
    this.child.on('exit',()=>{this.status.sensorOnline=false;if(!this.stopping)this.restartTimer=setTimeout(()=>this.startInfo(),5000);});
  }
  consumeNative(now) {
    const indices=new Set(this.interfaces.filter(n=>n.physical&&n.online).map(n=>n.index));
    const addresses=new Set(this.interfaces.filter(n=>n.physical&&n.online).flatMap(n=>n.addresses));
    const clashSourceAddresses=new Set(this.live.filter(c=>c.inboundType==='Tun').map(c=>c.localIP).filter(ip=>ip&&!['127.0.0.1','::1'].includes(ip)));
    const ready=this.nativePending.filter(m=>now-m.time>=4000);this.nativePending=this.nativePending.filter(m=>now-m.time<4000);
    for(const batch of ready)for(const f of batch.flows) {
      const proc=f.pid>0?this.processes.get(f.pid):undefined;const program=proc?.name||(f.pid>0?`PID ${f.pid}`:'未知程序');
      const matches=this.matches.get(`${f.protocol}:${f.localPort}`)||[];
      const matched=matches.some(c=>(!c.pid||c.pid===f.pid||c.name?.toLowerCase()===program.toLowerCase())&&Math.abs(batch.time-c.seen)<120000);
      const route=extraRoute(f,indices,addresses,matched,program,clashSourceAddresses);
      if(route==='TRANSPORT'||route==='DUPLICATE')continue;
      const r=this.enrich({time:batch.time,name:program,path:proc?.path||'',pid:f.pid,localPort:f.localPort,localIP:f.local,host:f.remote,ip:f.remote,port:f.remotePort,protocol:f.protocol,route,chain:route==='DIRECT'?'Windows 物理网卡路由':'路由未确认',source:'windows-etw',up:f.up,down:f.down});
      this.rows.push(r);const id=`${f.pid}:${f.protocol}:${f.localPort}:${f.remote}:${f.remotePort}`;
      this.etwLive.set(id,{...r,id:'windows-'+id,seen:now,uploadBytes:f.up,downloadBytes:f.down,uploadRate:f.up,downloadRate:f.down,started:new Date(batch.time).toISOString()});
    }
    for(const [k,v] of this.matches) {const keep=v.filter(c=>now-c.seen<120000);if(keep.length)this.matches.set(k,keep);else this.matches.delete(k);}
    for(const [k,v] of this.etwLive)if(now-v.seen>5000)this.etwLive.delete(k);
  }
  flush() {
    this.store.append(this.rows,this.physical,this.quality);this.rows=[];this.physical=[];this.quality=[];this.lastFlush=Date.now();
    this.store.setMeta('last_heartbeat_ms',this.lastFlush);
  }
  pause(value) {this.flush();this.config.paused=value;this.clash.reset();this.nativePending=[];this.nicPrevious.clear();this.live=[];this.etwLive.clear();this.points=[];this.store.event(value?'paused':'resumed',value?'User paused recording; networking continues':'Recording resumed with fresh baselines');}
  async loop() {
    while(!this.stopping) {
      const time=Date.now();
      if(!this.config.paused) {
        try {
          const current=await this.clash.snapshot();const delta=this.clash.observe(current,time);
          this.status.clashOnline=true;this.status.error=null;this.status.lastSampleAt=time;this.status.samples++;
          this.live=delta.connections.map(r=>this.enrich(r));
          for(const c of this.live) {
            if(c.route==='TRANSPORT'||!c.localPort)continue;
            const key=`${c.protocol}:${c.localPort}`,existing=this.matches.get(key)||[];
            const item={pid:c.pid,name:c.name,seen:time};const idx=existing.findIndex(x=>x.pid===item.pid&&x.name===item.name);
            if(idx>=0)existing[idx]=item;else existing.push(item);this.matches.set(key,existing);
          }
          this.rows.push(...delta.rows.map(r=>this.enrich(r)));
          if(!delta.baseline)this.quality.push({time,...delta});
          const p={time,directUp:0,directDown:0,proxyUp:0,proxyDown:0};
          for(const r of delta.rows){const prefix=r.route==='DIRECT'?'direct':r.route==='PROXY'?'proxy':null;if(prefix){p[prefix+'Up']+=r.up/delta.elapsed;p[prefix+'Down']+=r.down/delta.elapsed;}}
          this.points.push(p);if(this.points.length>300)this.points.shift();
          if(delta.reset)this.store.event('clash_reset','Clash counters reset; established a new baseline');
        }catch(e) {
          if(this.status.clashOnline)this.store.event('clash_offline','Clash local API disconnected');
          this.status.clashOnline=false;this.status.error=String(e.message).slice(0,180);this.live=[];
        }
        this.consumeNative(time);
      }
      if(time-this.lastFlush>=this.config.flushMs)this.flush();
      if(time-this.lastCleanup>=900000){this.store.cleanup(this.config.retentionDays);this.lastCleanup=time;}
      if(this.status.systemLastAt && time-this.status.systemLastAt>10000)this.status.systemOnline=false;
      await new Promise(resolve=>{this.timer=setTimeout(resolve,Math.max(30,this.config.sampleMs-(Date.now()-time)));});
    }
  }
  snapshot() {return {...this.status,paused:this.config.paused,connections:this.live.filter(c=>c.route!=='TRANSPORT').length+this.etwLive.size,internalConnections:this.live.filter(c=>c.route==='TRANSPORT').length,physicalRates:this.physicalRates,interfaces:this.interfaces,points:this.points,coverage:'Clash 每秒采样；Windows 增强采集补充未经过代理核心的连接。Mihomo Inner 内部连接单独留档，不与应用流量相加。短连接可能漏记，无法确认路线的记录单列。网卡计数单独展示。'};}
  connections() {return [...this.live,...this.etwLive.values()];}
  async stop() {this.stopping=true;clearTimeout(this.restartTimer);this.child?.kill();fs.writeFileSync(path.join(DATA,'system-stop.flag'),'stop');this.pipe?.close();await this.loopTask;this.flush();}
}
