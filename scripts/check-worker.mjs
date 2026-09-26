import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const base = process.argv[2] || 'http://127.0.0.1:8790';
const token = process.env.PROBE_TOKEN || readFileSync('.dev.vars', 'utf8').match(/^PROBE_TOKEN=(\S+)$/m)?.[1];
if (!token) throw new Error('Run node scripts/probe-secret.mjs first');
const run = randomUUID();
const samples = [];
const started = Date.now();
async function call(label, path, data, status = 200, auth = true) {
  const start = performance.now();
  const response = await fetch(new URL(path, base), {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  samples.push({ label, ray: response.headers.get('cf-ray'), http_ms: performance.now()-start, metrics: value.metrics });
  return value;
}
await call('unauthorized', '/search?term=hello', undefined, 401, false);
await call('invalid', '/update', {device:run,session:'invalid',records:[{line:0,text:'invalid'}]},400);
await call('too-many', '/update', {device:run,session:'invalid',records:Array.from({length:41},(_,i)=>({line:i+1,text:'invalid'}))},400);
await call('too-large', '/update', {device:run,session:'invalid',records:[{line:1,text:'x'.repeat(128*1024)}]},400);
for (const count of [1,10,40]) {
  for (let repeat=0;repeat<5;repeat++) {
    const session = `batch-${count}-${repeat}`;
    const records = Array.from({length:count},(_,i)=>({line:i+1,text:`probe${run} commonneedle 日本語検索 ${i} ${'synthetic content '.repeat(25)}`}));
    const input={device:run,session,records};
    const added=await call(`insert-${count}`, '/update',input);
    assert.ok(added.metrics.rows_written>0);
    const noop=await call(`noop-${count}`, '/update',input);
    assert.equal(noop.metrics.rows_written,0);
    await call(`change-${count}`, '/update',{...input,records:records.map(r=>({...r,text:r.text+' modified'}))});
  }
}
for (const term of ['commonneedle','日本語検索','語検']) {
  for (let i=0;i<5;i++) {
    const result=await call(`search-${term}`, `/search?term=${encodeURIComponent('probe'+run)}&term=${encodeURIComponent(term)}`);
    assert.equal(result.results.length,15);
  }
}
await call('isolation-a','/update',{device:run,session:'isolation',records:[{line:1,text:`isolation${run}`} ]});
await call('isolation-b','/update',{device:run+'b',session:'isolation',records:[{line:1,text:`isolation${run}`} ]});
assert.equal((await call('isolation-search','/search?term='+encodeURIComponent('isolation'+run))).results.length,2);
const cross={device:run,session:'cross',records:[{line:1,text:'crossfirst'+run},{line:2,text:'crosssecond'+run}]};
await call('cross-seed','/update',cross);
assert.equal((await call('cross-search',`/search?term=crossfirst${run}&term=crosssecond${run}`)).results.length,1);
assert.equal((await call('rollback','/rollback',{})).passed,true);
await call('delete','/update',{...cross,records:[{line:1,text:null}]});
assert.equal((await call('deleted-search',`/search?term=crossfirst${run}`)).results.length,0);
assert.equal((await call('delete-retry','/update',{...cross,records:[{line:1,text:null}]})).metrics.rows_written,0);
const report={base,run,started,finished:Date.now(),samples};
mkdirSync('results',{recursive:true});
writeFileSync(`results/worker-${base.startsWith('http://127.')?'local':'remote'}.json`,JSON.stringify(report,null,2)+'\n');
const grouped=Object.groupBy(samples,s=>s.label);
console.table(Object.entries(grouped).map(([label,ss])=>({label,requests:ss.length,http_ms: +(ss.reduce((a,s)=>a+s.http_ms,0)/ss.length).toFixed(2),rows_read:ss[0].metrics?.rows_read,rows_written:ss[0].metrics?.rows_written})));
console.log('All Worker assertions passed. Request timing is NOT Worker CPU time.');
