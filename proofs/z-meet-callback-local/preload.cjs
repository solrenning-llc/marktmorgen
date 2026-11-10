const {syncBuiltinESMExports}=require('node:module');
const state=globalThis.__zReview={redis:0,http:0,network:0};
globalThis.__zRedis=()=>{if(++state.redis>20000){process.stderr.write('Z_REDIS_CAP\n');process.exit(86)}};
const deny=()=>{state.network++;throw Error('Z_NETWORK_DENIED')};
for(const [name,keys] of [['node:http',['request','get']],['node:https',['request','get']],['node:net',['connect','createConnection']],['node:tls',['connect']],['node:dns',['lookup','resolve']]])for(const key of keys)require(name)[key]=deny;
let fetchValue=deny;
Object.defineProperty(globalThis,'fetch',{configurable:false,get(){return fetchValue},set(fn){fetchValue=(...args)=>{if(++state.http>100){process.stderr.write('Z_HTTP_CAP\n');process.exit(87)}return fn(...args)}}});
syncBuiltinESMExports();
process.on('exit',()=>process.stderr.write('Z_COUNTS '+JSON.stringify(state)+'\n'));
