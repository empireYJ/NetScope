import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';

export function validateProbe(value) {
  const host=String(value.host||'').trim().toLowerCase();
  if(host.length>253||!host||!net.isIP(host)&&(!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)||host.includes('..')))throw new Error('请输入主机名或 IP，不包含协议、路径或账号');
  const port=Number(value.port||443),count=Number(value.count||1),timeoutMs=Number(value.timeoutMs||5000);
  if(!Number.isInteger(port)||port<1||port>65535||!Number.isInteger(count)||count<1||count>5||!Number.isInteger(timeoutMs)||timeoutMs<300||timeoutMs>10000)throw new Error('Invalid port, count or timeout');
  const mode=value.mode||'system';if(!['system','clash'].includes(mode))throw new Error('Invalid probe mode');
  if(value.tls!==undefined&&typeof value.tls!=='boolean')throw new Error('tls must be boolean');
  return {host,port,count,timeoutMs,mode,tls:value.tls??port===443};
}
function mixedPort() {
  const file=path.join(process.env.APPDATA||'','io.github.clash-verge-rev.clash-verge-rev','clash-verge.yaml');
  const content=fs.readFileSync(file,'utf8');const port=Number(content.match(/^mixed-port:\s*(\d+)/m)?.[1]);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Clash mixed-port unavailable');return port;
}
async function connect(host,port,timeoutMs) {
  return new Promise((resolve,reject)=>{const socket=net.connect({host,port});const timer=setTimeout(()=>socket.destroy(Object.assign(new Error('Connect timeout'),{code:'ETIMEDOUT'})),timeoutMs);socket.once('connect',()=>{clearTimeout(timer);resolve(socket);});socket.once('error',e=>{clearTimeout(timer);reject(e);});});
}
async function tunnel(socket,host,port,timeoutMs) {
  return new Promise((resolve,reject)=>{
    let buffer=Buffer.alloc(0);const timer=setTimeout(()=>finish(Object.assign(new Error('Proxy timeout'),{code:'ETIMEDOUT'})),timeoutMs);
    const finish=e=>{clearTimeout(timer);socket.off('data',data);socket.off('error',error);if(e){socket.destroy();reject(e);}else resolve(socket);};
    const error=e=>finish(e);
    const data=b=>{buffer=Buffer.concat([buffer,b]);const end=buffer.indexOf('\r\n\r\n');if(buffer.length>16384)return finish(new Error('Proxy response too large'));if(end<0)return;if(!/^HTTP\/1\.[01] 2\d\d /i.test(buffer.toString('ascii',0,end)))return finish(Object.assign(new Error('Proxy CONNECT refused'),{code:'EPROXY'}));const rest=buffer.subarray(end+4);socket.pause();if(rest.length)socket.unshift(rest);finish();};
    socket.on('data',data);socket.once('error',error);const authority=net.isIP(host)===6?'['+host+']:'+port:host+':'+port;
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nConnection: keep-alive\r\n\r\n`);
  });
}
async function handshake(socket,host,timeoutMs) {
  return new Promise((resolve,reject)=>{const secure=tls.connect({socket,servername:net.isIP(host)?undefined:host,rejectUnauthorized:true});const timer=setTimeout(()=>secure.destroy(Object.assign(new Error('TLS timeout'),{code:'ETIMEDOUT'})),timeoutMs);secure.once('secureConnect',()=>{clearTimeout(timer);resolve(secure);});secure.once('error',e=>{clearTimeout(timer);reject(e);});});
}
export async function probeOnce(config,{proxyPort}={}) {
  const started=performance.now(),result={time:Date.now(),mode:config.mode,success:false,dnsMs:null,tcpMs:null,proxyMs:null,tlsMs:null,stage:'dns'};let socket;
  // One overall deadline bounds DNS, connect and TLS together.
  const remaining=()=>Math.max(1,config.timeoutMs-(performance.now()-started));
  try {
    if(config.mode==='system') {
      const begin=performance.now();let timer;
      const addresses=await Promise.race([dns.lookup(config.host,{all:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('DNS timeout'),{code:'ETIMEDOUT'})),remaining());})]).finally(()=>clearTimeout(timer));
      const address=addresses.find(a=>a.family===4)||addresses[0];if(!address)throw new Error('DNS returned no address');result.dnsMs=performance.now()-begin;result.address=address.address;
      result.stage='tcp';const tcp=performance.now();socket=await connect(address.address,config.port,remaining());result.tcpMs=performance.now()-tcp;
    }else {
      result.stage='proxy';const begin=performance.now();socket=await connect('127.0.0.1',proxyPort||mixedPort(),remaining());result.proxyLocalConnectMs=performance.now()-begin;
      const tunnelStart=performance.now();await tunnel(socket,config.host,config.port,remaining());result.proxyMs=performance.now()-tunnelStart;
    }
    if(config.tls){result.stage='tls';const begin=performance.now();socket=await handshake(socket,config.host,remaining());result.tlsMs=performance.now()-begin;result.tlsProtocol=socket.getProtocol();result.certificateVerified=socket.authorized;}
    result.success=true;result.stage='complete';
  }catch(error){result.errorCode=error.code||'PROBE_FAILED';result.error=String(error.message).replace(/[\r\n]/g,' ').slice(0,180);}
  finally{socket?.destroy();result.totalMs=performance.now()-started;}
  return result;
}
export class NetworkDiagnostics {
  constructor(store){this.store=store;this.active=0;this.lastStarted=0;}
  async run(input) {
    const config=validateProbe(input);if(this.active>=2)throw new Error('已有两个诊断任务正在运行');if(Date.now()-this.lastStarted<1000)throw new Error('请稍候再开始新的诊断');
    this.lastStarted=Date.now();this.active++;const time=Date.now(),rows=[];
    try {
      for(let i=0;i<config.count;i++)rows.push(await probeOnce(config));
      const successes=rows.filter(r=>r.success),values=successes.map(r=>r.totalMs),average=values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
      const result={id:crypto.randomUUID(),time,config,rows,summary:{successes:successes.length,attempts:rows.length,failurePercent:(rows.length-successes.length)/rows.length*100,averageMs:average,minMs:values.length?Math.min(...values):null,maxMs:values.length?Math.max(...values):null,variationMs:values.length>1?Math.sqrt(values.reduce((n,x)=>n+(x-average)**2,0)/(values.length-1)):null},note:config.mode==='system'?'系统套接字路由探测，可能经过 TUN；不能据此认定直连。未发送 HTTP 正文。':'显式经 Clash HTTP CONNECT 探测；目标 DNS 由代理处理，本机不报告该 DNS 或远端 TCP 的独立耗时。连接失败率不是 IP 丢包率。'};
      this.store.db.prepare('INSERT INTO network_probes VALUES(?,?,?,?,?,?)').run(result.id,time,config.host,config.port,config.mode,JSON.stringify(result));return result;
    }finally{this.active--;}
  }
  history(query={}) {
    const args=[];let where='1=1';if(query.host){where+=' AND host=?';args.push(String(query.host));}
    return {rows:this.store.db.prepare(`SELECT result FROM network_probes WHERE ${where} ORDER BY time DESC LIMIT 30`).all(...args).map(r=>JSON.parse(r.result)),active:this.active};
  }
}
