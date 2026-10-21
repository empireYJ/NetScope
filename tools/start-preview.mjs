import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {ROOT,DATA} from '../lib/config.mjs';
import {measureRequest} from '../lib/ai-recorder.mjs';

// A private online SQLite backup, never the live database, powers UI acceptance.
const directory=path.join(ROOT,'qa-output','preview-'+Date.now());fs.mkdirSync(directory,{recursive:true});
const source=new DatabaseSync(path.join(DATA,'traffic.sqlite'),{readOnly:true});await backup(source,path.join(directory,'traffic.sqlite'));source.close();
fs.writeFileSync(path.join(directory,'settings.json'),JSON.stringify({port:47832,systemEnabled:false,alertEnabled:false,aiDiagnosticsEnabled:false,paused:true,effects:false}));
fs.writeFileSync(path.join(ROOT,'qa-output','preview-session.json'),JSON.stringify({directory,port:47832},null,2));
const stamp=Date.now();const metrics=[0,1].map(n=>measureRequest({image:'data:image/png;base64,YWJjZGVm',text:'UI acceptance fixture only'},{provider:'sdk',requestId:'preview-'+stamp+'-'+n,time:stamp,sessionId:'preview-only',label:'SDK 验收样本（仅副本）',attempt:n+1}));
fs.writeFileSync(path.join(ROOT,'qa-output','v11-preview-metrics.json'),JSON.stringify(metrics));
process.stdout.write(JSON.stringify({preview:'http://127.0.0.1:47832/#insights',data:directory})+'\n');
const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',path.join(ROOT,'server.mjs')],{cwd:ROOT,env:{...process.env,NETSCOPE_DATA_DIR:directory,NETSCOPE_OFFLINE:'1'},windowsHide:true,stdio:'inherit'});
await new Promise(resolve=>child.on('exit',resolve));
