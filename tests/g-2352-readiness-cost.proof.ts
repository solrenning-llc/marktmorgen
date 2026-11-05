import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceMailRouteReady} from '@/lib/email';
import {installSesMailFixture} from './ses-mail-fixture';
import {store as redis} from './redis-stub';
test('a cold early readiness check also refreshes SES account and role credentials; warm checks reuse both',async()=>{
redis.clear();const f=installSesMailFixture(),real=redis.pipeline.bind(redis),trace:(string|number)[][]=[];
try{f.configure();redis.pipeline=async commands=>{trace.push(...commands);return real(commands);};
assert.equal(await serviceMailRouteReady(),true);
const cold={...f.calls,redis:trace.map(c=>[c[0],c[1]])};console.log('COLD',cold);
assert.equal(f.calls.account,1);assert.equal(f.calls.sts,1);assert.equal(f.calls.ses,0);assert.equal(f.calls.resend,0);
assert.ok(trace.some(c=>c[0]==='SET'&&c[1]==='nl:ses:state'));
trace.length=0;assert.equal(await serviceMailRouteReady(),true);
console.log('WARM',{...f.calls,redis:trace.map(c=>[c[0],c[1]])});
assert.equal(f.calls.account,1);assert.equal(f.calls.sts,1);assert.deepEqual(trace,[['GET','nl:ses:state']]);
}finally{redis.pipeline=real;f.restore();}
});
