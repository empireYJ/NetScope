import path from 'node:path';
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT} from './config.mjs';
const exec=promisify(execFile);
export const powershell=path.join(process.env.SystemRoot||'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
export function shortcutPath() {return path.join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Startup','墨流 NetScope.lnk');}
export function autoStartEnabled() {return fs.existsSync(shortcutPath());}
export async function autoStart(enabled) {
  const {stdout}=await exec(powershell,['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'scripts','autostart.ps1'),'-Mode',enabled?'enable':'disable'],{windowsHide:true,timeout:15000});
  return JSON.parse(stdout.replace(/^\uFEFF/,''));
}
export async function enableSystem() {
  // The elevation is limited to the read-only Windows network event sensor.
  return exec(powershell,['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'scripts','enable-system.ps1')],{windowsHide:true,timeout:120000});
}
export async function resumeSystem() {
  return exec(powershell,['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'scripts','resume-system.ps1')],{windowsHide:true,timeout:45000});
}
