import crypto from 'node:crypto';

/** Extract sizes and image hashes locally. The body itself never leaves this function. */
export function measureRequest(body,metadata={}) {
  const serialized=JSON.stringify(body);if(serialized===undefined)throw new Error('JSON request body required');
  const images=new Map();let imageBytes=0,imageCount=0;
  const visit=value=>{
    if(typeof value==='string'&&/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) {
      const encodedBytes=Buffer.byteLength(value);const hash=crypto.createHash('sha256').update(value).digest('hex');
      const previous=images.get(hash);images.set(hash,{hash,encodedBytes,occurrences:(previous?.occurrences||0)+1});imageBytes+=encodedBytes;imageCount++;
    }else if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')Object.values(value).forEach(visit);
  };
  visit(body);
  return {...metadata,time:metadata.time??Date.now(),provider:metadata.provider||'sdk',requestId:metadata.requestId||crypto.randomUUID(),preBytes:Buffer.byteLength(serialized),imageBytes,imageCount,images:[...images.values()]};
}

export async function reportRequestMetric(base,token,metric) {
  const url=new URL('/api/v1/ai/metrics',base);
  if(url.hostname!=='127.0.0.1'&&url.hostname!=='localhost')throw new Error('Local NetScope endpoint required');
  const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-NetScope-Key':token},body:JSON.stringify({metrics:[metric]})});
  if(!res.ok)throw new Error('NetScope metric report failed: '+res.status);return res.json();
}
