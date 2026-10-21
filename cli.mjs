import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT,DATA,readConfig} from './lib/config.mjs';
import {powershell} from './lib/platform.mjs';
const exec=promisify(execFile);
const argv=process.argv.slice(2),command=argv.shift()||'help',args={},pos=[];
for(let i=0;i<argv.length;i++){if(argv[i].startsWith('--'))args[argv[i].slice(2)]=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true;else pos.push(argv[i]);}
const base=`http://127.0.0.1:${readConfig().port}`;
const commands={
  status:'采集状态与存储使用',report:'四个排行榜与流量汇总（内部转发单列）',top:'--route direct|vpn|all|unknown|transport --direction upload|download --range all|1h|24h|7d|30d；all 不含内部层',
  process:'--key <程序 key>，或 --name <精确程序名>；查看进程和目标详情',connections:'当前连接 --route direct|vpn|all',history:'分钟历史与趋势 --from <ISO时间> --to <ISO时间>',
  events:'采集事件',records:'分页读取分钟明细 --limit 500 --cursor <nextCursor> --json',watch:'--interval 5 --count 12 --json；逐行输出 JSON，count=0 持续',
  config:'get | set --retention-days 30 --autostart on|off --effects on|off --alerts on|off --hourly-gb 1',
  control:'pause | resume | compact',system:'enable | disable（enable 会请求 Windows 管理员权限）',
  export:'--format json|csv --out <文件路径>',start:'后台启动',open:'启动并打开界面',stop:'停止本程序，网络任务继续',doctor:'检查本地采集状态',help:'--json 提供机器可读命令说明'};
Object.assign(commands,{peaks:'分钟峰值 --direction upload|download|total',replay:'--at <ISO或毫秒> --minutes 5',compare:'--from ISO --to ISO [--baseline-from ISO --baseline-to ISO]',routes:'保留的代理规则与链路',route:'--flow-id ID 查看链路解释',trust:'采样、归属和去重证据',projects:'list | create --name NAME | bind --id ID --program KEY / --domain HOST / --pid PID | unbind --id RULE_ID | delete --id ID',rules:'list | add/set --file metadata.json [--id ID] | delete --id ID',ai:'summary | scan | import --file metrics.jsonl（最多100条元数据）',probe:'--host example.com --mode system|clash --count 3 --port 443 [--tls on|off]',bundle:'--out diagnostic.json [--include-hosts true]',processes:'可绑定的实时进程库存', 'mcp-config':'输出本机只读 stdio MCP 配置，不修改客户端设置'});
function compactStatus(value) {const {points,interfaces,...rest}=value;return {...rest,interfaceCount:interfaces?.length||0};}
function output(value) {
  if(!args.full&&['status','doctor','watch'].includes(command))value=compactStatus(value);
  if(!args.full&&command==='report'){const {series,...summary}=value;value={...summary,live:compactStatus(value.live)};}
  if(args.json||command==='watch')console.log(JSON.stringify(value));else if(typeof value==='string')console.log(value);else console.log(JSON.stringify(value,null,2));
}
async function request(endpoint,body,method='POST',raw=false) {
  const options={signal:AbortSignal.timeout(endpoint.includes('control')?120000:endpoint==='probes'&&body!==undefined?65000:endpoint==='ai/scan'?30000:10000)};
  if(body!==undefined){options.method=method;options.headers={'Content-Type':'application/json','X-NetScope-Key':fs.readFileSync(path.join(DATA,'api-token'),'utf8').trim()};options.body=JSON.stringify(body);}
  let res;
  for(let attempt=0;!res;attempt++)try{res=await fetch(base+'/api/v1/'+endpoint,options);}catch(error){if(body!==undefined||attempt>=2)throw error;await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));}
  if(!res.ok)throw new Error((await res.json()).error||'HTTP '+res.status);
  return raw?await res.text():await res.json();
}
const q=new URLSearchParams();for(const name of ['range','from','to','search','key','limit','offset','cursor'])if(args[name]!==undefined)q.set(name,args[name]);
for(const [flag,name] of [['at','at'],['minutes','minutes'],['baseline-from','baselineFrom'],['baseline-to','baselineTo'],['flow-id','flowId'],['include-hosts','includeHosts']])if(args[flag]!==undefined)q.set(name,String(args[flag]));
if(args['include-transport']!==undefined)q.set('includeTransport',String(args['include-transport']));
if(args.route){const route={direct:'DIRECT',vpn:'PROXY',proxy:'PROXY',all:'ALL',unknown:'UNKNOWN',transport:'TRANSPORT'}[String(args.route).toLowerCase()];if(!route){console.error(JSON.stringify({error:'Invalid route'}));process.exit(2);}q.set('route',route);}
if(args.direction)q.set('sort',args.direction);
try {
  if(command==='help')output({app:'NetScope',apiVersion:1,commands,defaults:{range:'all',units:'decimal bytes / GB',output:'--json for machine-readable JSON'},exitCodes:{success:0,error:1,invalidRoute:2},readOnly:['status','report','top','process','connections','history','records','events','doctor','peaks','replay','compare','routes','route','trust','processes','projects list','rules list','ai summary','mcp-config']});
  else if(command==='start'||command==='open') {const run=await exec(powershell,['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'start.ps1'),...(command==='open'?['-Open']:[])],{windowsHide:true});output(JSON.parse(run.stdout.trim()));}
  else if(command==='watch') {const interval=Math.max(1,Number(args.interval)||5),count=Math.max(0,Number(args.count)||0);for(let i=0;!count||i<count;i++){output(await request('status'));if(!count||i+1<count)await new Promise(r=>setTimeout(r,interval*1000));}}
  else if(command==='config') {
    if(!pos[0]||pos[0]==='get')output(await request('settings'));
    else if(pos[0]==='set') {
      const change={};if(args['retention-days']!==undefined)change.retentionDays=Number(args['retention-days']);
      if(args['hourly-gb']!==undefined)change.alertHourlyGB=Number(args['hourly-gb']);
      if(args['ai-diagnostics']!==undefined){if(!['on','off'].includes(args['ai-diagnostics']))throw new Error('ai-diagnostics must be on or off');change.aiDiagnosticsEnabled=args['ai-diagnostics']==='on';}
      for(const [flag,key] of [['autostart','autoStart'],['effects','effects'],['alerts','alertEnabled']])if(args[flag]!==undefined){if(!['on','off'].includes(args[flag]))throw new Error(flag+' must be on or off');change[key]=args[flag]==='on';}
      if(!Object.keys(change).length)throw new Error('No settings supplied');output(await request('settings',change,'PATCH'));
    }else throw new Error('Use config get or config set');
  }else if(command==='mcp-config')output({mcpServers:{netscope:{command:process.execPath,args:[path.join(ROOT,'mcp.mjs')]}}});
  else if(command==='projects') {
    const action=pos[0]||'list';
    if(action==='list')output(await request('projects?'+q));
    else if(action==='create')output(await request('projects',{name:args.name,color:args.color}));
    else if(action==='delete'||action==='unbind')output(await request((action==='delete'?'projects':'project-rules')+'?id='+encodeURIComponent(args.id||''),{},'DELETE'));
    else if(action==='bind') {
      let rule;if(args.program)rule={kind:'program',value:args.program};else if(args.domain)rule={kind:'domain',value:args.domain};
      else if(args.pid){const rows=(await request('process-tree')).rows;const p=rows.find(p=>p.pid===Number(args.pid));if(!p?.started)throw new Error('Process lifetime not available; choose an existing live process');rule={kind:'process-tree',value:{pid:p.pid,started:p.started}};}
      else throw new Error('Supply --program, --domain or --pid');output(await request('project-rules',{projectId:args.id,...rule}));
    }else throw new Error('Unknown project action');
  }else if(command==='rules') {
    const action=pos[0]||'list';
    if(action==='list')output(await request('rules'));
    else if(action==='delete')output(await request('rules?id='+encodeURIComponent(args.id||''),{},'DELETE'));
    else if(action==='add'||action==='set') {if(!args.file)throw new Error('--file with a rule JSON object is required');const value=JSON.parse(fs.readFileSync(path.resolve(args.file),'utf8').replace(/^\uFEFF/,''));output(await request('rules'+(action==='set'?'?id='+encodeURIComponent(args.id||''):''),value,action==='set'?'PATCH':'POST'));}
    else throw new Error('Unknown rule action');
  }else if(command==='ai') {
    const action=pos[0]||'summary';
    if(action==='summary')output(await request('ai?'+q));else if(action==='scan')output(await request('ai/scan',{}));
    else if(action==='import'){if(!args.file)throw new Error('--file is required');const file=path.resolve(args.file);if(fs.statSync(file).size>1048576)throw new Error('Metric import file exceeds 1 MB');const data=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').trim();const metrics=data.startsWith('[')?JSON.parse(data):data.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));output(await request('ai/metrics',{metrics}));}
    else throw new Error('Unknown AI action');
  }else if(command==='probe') {
    if(args.tls!==undefined&&!['on','off'].includes(args.tls))throw new Error('tls must be on or off');
    output(await request('probes',{host:args.host,port:Number(args.port||443),mode:args.mode||'system',count:Number(args.count||3),...(args.tls!==undefined?{tls:args.tls==='on'}:{})}));
  }else if(command==='bundle') {const value=await request('bundle?'+q);if(args.out){const file=path.resolve(args.out);fs.writeFileSync(file,JSON.stringify(value,null,2));output({ok:true,path:file,records:value.records.length,redacted:!value.privacy.hostnamesIncluded});}else output(value);}
  else if(command==='control'||command==='system'||command==='stop') {
    const action=command==='stop'?'stop':command==='system'?'system-'+pos[0]:pos[0];output(await request('control',{action}));
  }else if(command==='export') {q.set('format',args.format||'json');const value=await request('export?'+q,undefined,'GET',true);if(args.out){fs.writeFileSync(path.resolve(args.out),value);output({ok:true,path:path.resolve(args.out),bytes:Buffer.byteLength(value)});}else process.stdout.write(value+'\n');}
  else if(command==='process') {
    if(!q.has('key')&&args.name){const lookup=new URLSearchParams(q);lookup.set('search',args.name);const result=await request('programs?'+lookup);const matches=result.rows.filter(r=>r.name.toLowerCase()===args.name.toLowerCase());if(matches.length!==1)throw new Error('Program name is missing or ambiguous; use top and --key');q.set('key',matches[0].key);}
    output(await request('program?'+q));
  }else {const endpoint={status:'status',doctor:'status',report:'dashboard',top:'programs',connections:'connections',history:'history',records:'records',events:'events',peaks:'peaks',replay:'replay',compare:'compare',routes:'routes',route:'route',trust:'trust',processes:'process-tree'}[command];if(!endpoint)throw new Error('Unknown command: '+command);output(await request(endpoint+'?'+q));}
}catch(error){console.error(JSON.stringify({ok:false,error:error.message==='fetch failed'?'NetScope 未运行或本机连接失败。':error.message,...(args.debug?{base,cause:error.cause?.code||error.cause?.message}:{} )}));process.exitCode=1;}
