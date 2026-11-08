/** Present malformed owner text is not confirmed absence; synthetic Redis/SES only. */
import {recordDelivery,rememberFolderOwner,DELIVERY_ALLOWANCE_BYTES} from "@/lib/delivery";
import {GET} from "@/app/api/cron/usage/route";
import {store as redis} from "./redis-stub";
import {installSesMailFixture} from "./ses-mail-fixture";
import {SUPPORT_EMAIL} from "@/lib/creator-research";
import {done,is} from "./check";
delete process.env.RESEND_API_KEY;delete process.env.CRON_SECRET;
const sentBodyBytes:number[]=[];
const fixture=installSesMailFixture({onSes:(_message,_input,init)=>{sentBodyBytes.push(Buffer.byteLength(String(init?.body??"")));return undefined;}});fixture.configure();
const real=redis.pipeline.bind(redis),folder="z".repeat(32),owner="owner@example.com";
const request={headers:new Headers(),nextUrl:new URL("https://marktmorgen.com/api/cron/usage")} as Parameters<typeof GET>[0];
let fault:unknown="healthy";
redis.pipeline=async commands=>{
 if(fault!=="healthy"&&commands.length&&commands.every(c=>c[0]==="GET"&&String(c[1]).startsWith("nl:store:folder-owner:"))){
  if(fault==="throw")throw Error("synthetic unknown owner read");
  if(fault==="missing")return [];
  return [fault];
 }
 return real(commands);
};
async function marked(){const [raw]=await real([["GET","nl:usage-watch:told"]]);return typeof raw==="string"&&(JSON.parse(raw) as string[]).includes(folder);}
async function setup(address:string|null=owner){redis.clear();fixture.reset();sentBodyBytes.length=0;fault="healthy";if(address)await rememberFolderOwner(folder,address);await recordDelivery(`stores/${folder}/prod01/file.zip`,DELIVERY_ALLOWANCE_BYTES+1024);}
async function main(){
 for(const vector of ["throw","missing",42,""," ","not-an-owner"]){
  await setup();fault=vector;const first=await GET(request);fault="healthy";
  const firstRecipients=fixture.sent.flatMap(x=>x.to),beforeRetry=fixture.sent.length,toldBeforeRetry=await marked(),firstProviderBodyBytes=[...sentBodyBytes];
  const retry=await GET(request),retryRecipients=fixture.sent.slice(beforeRetry).flatMap(x=>x.to);
  console.log(JSON.stringify({vector,firstStatus:first.status,firstRecipients,toldBeforeRetry,retryStatus:retry.status,retryRecipients,firstProviderBodyBytes}));
  is(`${JSON.stringify(vector)} unknown owner sends nobody`,[first.status,firstRecipients],[200,[]]);
  is(`${JSON.stringify(vector)} unknown owner is not marked told`,toldBeforeRetry,false);
  is(`${JSON.stringify(vector)} healthy recovery reaches the real owner`,[retry.status,retryRecipients,await marked()],[200,[owner],true]);
 }
 await setup();await GET(request);
 is("healthy control reaches owner",fixture.sent.flatMap(x=>x.to),[owner]);
 is("healthy control marked told",await marked(),true);
 await GET(request);is("healthy control is not repeated",fixture.sent.length,1);
 await setup(null);await GET(request);
 is("confirmed absent owner key tells support",fixture.sent.flatMap(x=>x.to),[SUPPORT_EMAIL]);
 is("confirmed absent owner key marked handled",await marked(),true);
 await GET(request);is("confirmed absent control is not repeated",fixture.sent.length,1);
 fixture.restore();redis.pipeline=real;done();
}
void main();
