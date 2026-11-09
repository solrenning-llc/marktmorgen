import {ownedRepositoryEnv} from "./owned-repository.mjs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const CLI=fileURLToPath(new URL("./node_modules/@guidepup/setup/bin/guidepup",import.meta.url));
/** Only preparation is repeatable; the real reader and speech assertions run once. */
export async function setupOwnedReader(options={}){
 const {env=process.env,platform=process.platform,run=spawnSync,
  wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}=options;
 if(env.GITHUB_ACTIONS!=="true"||!ownedRepositoryEnv(env)||
    env.AX2_PUBLIC_DISPOSABLE_RUNNER!=="true"||!["darwin","win32"].includes(platform))
  throw Error("Reader setup requires the owned disposable public CI runner");
 function attempt(){
  return run(process.execPath,[CLI,"setup","--ci"],{encoding:"utf8",timeout:210000,maxBuffer:1024*1024,
   stdio:["ignore","pipe","pipe"],env});
 }
 function succeeded(result){return result.status===0&&!result.signal&&!result.error;}
 const first=attempt();
 if(succeeded(first))return {attempts:1};
 const output=String(first.stdout??"")+String(first.stderr??"");
 const permissionPropagation=platform==="darwin"&&!first.signal&&!first.error&&
  first.status!==null&&first.status!==0&&
  output.includes('Failed to enable "Do not disturb" mode')&&
  output.includes("osascript is not allowed to send keystrokes");
 // A download can fail before preferences are installed. Only the pinned
 // macOS preferences asset plus an explicit network-fetch failure qualifies;
 // signature, mount, permission, timeout and unknown errors remain failures.
 const cacheAsset="guidepup-voiceover-preferences-macos-26.dmg";
 const cacheDownload=platform==="darwin"&&!first.signal&&!first.error&&
  first.status!==null&&first.status!==0&&
  output.includes(`Failed to download Guidepup cache asset: ${cacheAsset}`)&&
  (output.includes("Cause: TypeError: fetch failed")||
   output.includes(`Cause: Error: Failed to download Guidepup cache asset: ${cacheAsset} (504 )`));
 if(!permissionPropagation&&!cacheDownload)throw Error("Reader preparation failed; no permitted recovery");
 // Repeat only idempotent preparation once. Never skip download validation,
 // change SIP/TCC protections, retry the reader pilot or convert failure to approval.
 await wait(2000);
 if(!succeeded(attempt()))throw Error("Reader preparation remained unavailable");
 return {attempts:2};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 setupOwnedReader().then(result=>console.log("Owned reader preparation completed; attempts="+result.attempts))
  .catch(()=>{console.error("Owned reader preparation failed; actual reader approval is unavailable.");process.exitCode=1;});
}
