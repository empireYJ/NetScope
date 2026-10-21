import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {DATA,VERSION,readConfig} from './lib/config.mjs';

const allowControl=process.argv.includes('--allow-control'),allowProbes=process.argv.includes('--allow-probes');
const range={range:{type:'string',enum:['all','1h','24h','7d','30d']},from:{type:'string'},to:{type:'string'},route:{type:'string',enum:['DIRECT','PROXY','UNKNOWN','TRANSPORT','ALL']},key:{type:'string'},search:{type:'string'}};
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const read=(name,title,endpoint,properties=range,required=[])=>({name:'netscope_'+name,title,description:title+'。字节为十进制字节，内部层与应用层不能相加。',inputSchema:schema(properties,required),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},endpoint});
const tools=[read('status','采集器状态和存储','status',{}),read('report','四榜和应用流量汇总','dashboard'),read('peaks','分钟流量峰值','peaks',{...range,sort:{type:'string',enum:['upload','download','total']},limit:{type:'integer',minimum:1,maximum:100}}),
  read('replay','回溯峰值附近的程序、目标和事件','replay',{...range,at:{type:'string'},minutes:{type:'integer',minimum:1,maximum:60}},['at']),
  read('compare','比较两个时段的程序流量变化','compare',{...range,baselineFrom:{type:'string'},baselineTo:{type:'string'}},['from','to']),
  read('routes','代理路径和规则证据','routes'),read('explain_route','解释一个保留的历史流','route',{flowId:{type:'integer',minimum:1}},['flowId']),
  read('trust','归属覆盖、漏采时段和修正证据','trust'),read('projects','按显式规则归组的项目统计','projects'),read('rules','预算、异常和发现提醒规则','rules',{}),read('ai_summary','AI 请求正文元数据，与网络账本分开','ai'),read('probe_history','已有网络诊断结果，不主动联网','probes',{host:{type:'string'}}),read('bundle','默认脱敏的诊断证据摘要','bundle',{...range,includeHosts:{type:'boolean'},limit:{type:'integer',minimum:1,maximum:500}})];
if(allowControl)tools.push(
  {name:'netscope_control',title:'控制本机采集',description:'显式暂停、恢复采集或整理数据库；不影响其他应用联网。',inputSchema:schema({action:{type:'string',enum:['pause','resume','compact']}},['action']),endpoint:'control',method:'POST',annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
  {name:'netscope_create_project',title:'建立项目分组',description:'创建显式项目；之后使用 CLI/界面添加匹配规则。',inputSchema:schema({name:{type:'string',minLength:1,maxLength:80}},['name']),endpoint:'projects',method:'POST',annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
  {name:'netscope_ai_scan',title:'导入本机 Codex 大小日志',description:'只读读取最近24小时的请求压缩大小元数据，并写入 NetScope；不读取正文，不重启 Codex。',inputSchema:schema({}),endpoint:'ai/scan',method:'POST',annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}}
);
if(allowProbes)tools.push({name:'netscope_probe',title:'主动诊断目标连接',description:'按需执行最多5次 DNS/TCP/TLS 连接。会联系所指定目标；不发送 HTTP 正文。',inputSchema:schema({host:{type:'string'},port:{type:'integer',minimum:1,maximum:65535},mode:{type:'string',enum:['system','clash']},count:{type:'integer',minimum:1,maximum:5},tls:{type:'boolean'}},['host']),endpoint:'probes',method:'POST',annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}});
function validate(args,input) {
  if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('arguments must be an object');
  for(const k of input.required||[])if(args[k]===undefined)throw new Error('Missing '+k);
  for(const [k,v] of Object.entries(args)) {const s=input.properties[k];if(!s)throw new Error('Unknown argument '+k);if(s.type==='integer'?!Number.isInteger(v):typeof v!==s.type)throw new Error('Invalid '+k);if(s.enum&&!s.enum.includes(v)||s.minimum!==undefined&&v<s.minimum||s.maximum!==undefined&&v>s.maximum||s.minLength!==undefined&&v.length<s.minLength||s.maxLength!==undefined&&v.length>s.maxLength)throw new Error('Invalid '+k);}
}
async function call(tool,args) {
  validate(args,tool.inputSchema);let endpoint=tool.endpoint;const method=tool.method||'GET';
  const options={method,signal:AbortSignal.timeout(method==='GET'?15000:65000)};
  if(method==='GET'){const q=new URLSearchParams(Object.entries(args).map(([k,v])=>[k,String(v)]));if(endpoint==='bundle'&&!q.has('limit'))q.set('limit','100');endpoint+='?'+q;}
  else{options.headers={'Content-Type':'application/json','X-NetScope-Key':fs.readFileSync(path.join(DATA,'api-token'),'utf8').trim()};options.body=JSON.stringify(args);}
  let res;for(let i=0;!res;i++)try{res=await fetch(`http://127.0.0.1:${readConfig().port}/api/v1/`+endpoint,options);}catch(e){if(method!=='GET'||i===2)throw e;await new Promise(r=>setTimeout(r,100));}
  let result=await res.json();if(!res.ok)throw new Error(result.error||'Local API error');
  if(tool.endpoint==='status'){const {points,interfaces,...compact}=result;result={...compact,interfaceCount:interfaces?.length||0};}
  if(tool.endpoint==='dashboard'){const {series,live,...compact}=result;result=compact;}
  return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false};
}
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let queue=Promise.resolve();
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',line=>{queue=queue.then(async()=>{
  let message;try{if(Buffer.byteLength(line)>65536)throw new Error('message too large');message=JSON.parse(line);}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON message'}});return;}
  const id=message.id;if(id===undefined)return;
  if(message.jsonrpc!=='2.0'||typeof message.method!=='string'){send({jsonrpc:'2.0',id,error:{code:-32600,message:'Invalid request'}});return;}
  try {
    let result;
    if(message.method==='initialize'){const requested=message.params?.protocolVersion;result={protocolVersion:['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(requested)?requested:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'netscope-local',version:VERSION},instructions:'只使用实际保留的数据。未知、估算和缺口必须明确指出。内部转发、应用计数和 AI 请求正文不可相加。默认不启用控制或主动探测。'};}
    else if(message.method==='ping')result={};
    else if(message.method==='tools/list')result={tools:tools.map(({endpoint,method,...t})=>t)};
    else if(message.method==='tools/call'){const tool=tools.find(t=>t.name===message.params?.name);if(!tool){send({jsonrpc:'2.0',id,error:{code:-32602,message:'Unknown or disabled tool'}});return;}try{result=await call(tool,message.params.arguments||{});}catch(e){result={content:[{type:'text',text:e.message==='fetch failed'?'NetScope 本地服务暂未连接。':e.message}],isError:true};}}
    else{send({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}});return;}
    send({jsonrpc:'2.0',id,result});
  }catch(e){send({jsonrpc:'2.0',id,error:{code:-32603,message:e.message}});}
}).catch(e=>process.stderr.write('MCP error: '+e.message+'\n'));});
