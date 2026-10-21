import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('a duplicate backend cannot open or migrate the database before acquiring its port',async()=>{
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'netscope-startup-'));
 fs.writeFileSync(path.join(folder,'settings.json'),JSON.stringify({port:server.address().port,systemEnabled:false}));
 try {
  const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(new URL('../server.mjs',import.meta.url))],{env:{...process.env,NETSCOPE_DATA_DIR:folder},windowsHide:true});
  let stderr='';child.stderr.on('data',b=>stderr+=b);child.stdout.resume();
  const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
  assert.equal(code,1);assert.match(stderr,/EADDRINUSE/);
  assert.equal(fs.existsSync(path.join(folder,'traffic.sqlite')),false);
 }finally{await new Promise(r=>server.close(r));}
});
