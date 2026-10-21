import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version;
export const DATA=process.env.NETSCOPE_DATA_DIR?path.resolve(process.env.NETSCOPE_DATA_DIR):path.join(ROOT,'data');
export const defaults={port:47831,retentionDays:30,autoStart:true,effects:true,paused:false,systemEnabled:false,alertEnabled:true,alertHourlyGB:1,aiDiagnosticsEnabled:false,sampleMs:1000,flushMs:5000};
export function atomicJSON(file,value) {fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,file);}
export function readConfig() {try{return {...defaults,...JSON.parse(fs.readFileSync(path.join(DATA,'settings.json'),'utf8'))};}catch{return {...defaults};}}
export function validateConfig(change) {
  for(const [k,v] of Object.entries(change)) {
    if(!['retentionDays','autoStart','effects','paused','alertEnabled','alertHourlyGB','aiDiagnosticsEnabled'].includes(k)) throw new Error(`Unknown setting: ${k}`);
    if(k==='retentionDays' && (!Number.isInteger(v)||v<0||v>3650)) throw new Error('保留天数须为 1–3650；0 表示永久保留');
    if(k==='alertHourlyGB'&&(!Number.isFinite(v)||v<0.1||v>100000))throw new Error('每小时提醒阈值须为 0.1–100000 GB');
    if(!['retentionDays','alertHourlyGB'].includes(k) && typeof v!=='boolean') throw new Error(`${k} must be boolean`);
  }
  return change;
}
export function saveConfig(config) {atomicJSON(path.join(DATA,'settings.json'),config);}
