import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isValidElement,type ReactNode} from 'react';
import {NextRequest} from 'next/server';
import {POST} from '@/app/api/auth/code/route';
import CodePage from '@/app/signin/code/page';
import {holdSignIn} from '@/lib/two-step';
import {store as redis} from './redis-stub';
import {setToken,Redirected} from './t-3065-next-world';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
function alerts(node:ReactNode):string[]{
 if(Array.isArray(node))return node.flatMap(alerts);
 if(!isValidElement<{role?:string;children?:ReactNode}>(node))return [];
 return node.props.role==='alert'?[String(node.props.children)]:alerts(node.props.children);
}
async function scenario(failRead:number){
 redis.clear();process.env.NIMBUS_DATA_KEY??='tests-only-not-a-real-deployment-secret';
 const who='reset-stage@example.com',key=`nl:2fa:${sha(`nimbus-2fa:${who}`).slice(0,40)}`;
 const original=redis.pipeline.bind(redis);
 await original([['SET',key,JSON.stringify({s:'synthetic-sealed-secret',since:1,codes:[],last:-1,reset:0,backup:''})]]);
 const token=await holdSignIn(who);setToken(token);let reads=0;
 redis.pipeline=(async commands=>{const out=await original(commands);return commands.map((c,i)=>c[0]==='GET'&&c[1]===key&&++reads===failRead?{}:out[i]);}) as typeof redis.pipeline;
 const log=console.error;console.error=()=>{};
 let response:Response;
 try{response=await POST(new NextRequest('https://marktmorgen.com/api/auth/code',{method:'POST',body:new URLSearchParams({action:'reset'}),headers:{'content-type':'application/x-www-form-urlencoded',cookie:`nl_2fa=${token}`}}));}
 finally{redis.pipeline=original;console.error=log;}
 assert.equal(response.headers.get('location'),'https://marktmorgen.com/signin/code?status=reset-unknown');
 try{const page=await CodePage({searchParams:Promise.resolve({status:'reset-unknown'})});return{kind:'notice',alert:alerts(page)};}
 catch(e){if(e instanceof Redirected)return{kind:'redirect',destination:e.destination};throw e;}
}
async function main(){
 const early=await scenario(1);assert.deepEqual(early,{kind:'notice',alert:['We could not let you in just now, and nothing was changed. Wait a moment, then try again.']});
 const late=await scenario(2);assert.deepEqual(late,{kind:'redirect',destination:'/signin?status=login-unknown'});
 console.log(JSON.stringify({early,late,checks:4}));
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
