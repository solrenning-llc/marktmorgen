import {ownedRepositoryEnv} from "./owned-repository.mjs";
import {spawnSync} from "node:child_process";
import {realpathSync} from "node:fs";
import {fileURLToPath} from "node:url";
const CLI=fileURLToPath(new URL("./node_modules/@guidepup/setup/bin/guidepup",import.meta.url));
// Guidepup resolves the reader manifest from the working directory's @guidepup/guidepup.
const TOOLING=fileURLToPath(new URL(".",import.meta.url));
/** The exact pinned asset each platform downloads (@guidepup/guidepup 0.36.4 manifest). */
export const PINNED_READER_ASSETS={
 win32:"guidepup-nvda-0.2.1-2026.2.zip",
 darwin:"guidepup-voiceover-preferences-macos-26.dmg",
};
/**
 * Installs the version-matched reader assets. Like reader preparation, only this
 * provisioning step may repeat, and only once, only after the exact pinned asset
 * failed to download with a network fetch failure or HTTP 504 from the release
 * host (merge-group jobs 129011602367, 129042996110, 129914526510 and others:
 * the host answered 504 to one runner while others downloaded it the same minute).
 * Guidepup still verifies the asset's pinned SHA-256 after every download; a
 * checksum, extraction, permission or unknown failure is never repeated. The
 * install has no time limit of its own (a slow download that would finish is not
 * cut short): a stalled one ends at the job's timeout-minutes, which fails the job
 * and is never repeated either, and a killed attempt (a signal) is not a download
 * failure, so it never qualifies for the one repeat.
 */
export async function installReaderAssets(options={}){
 const {env=process.env,platform=process.platform,run=spawnSync,
  wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  write=text=>process.stdout.write(text)}=options;
 if(env.GITHUB_ACTIONS!=="true"||!ownedRepositoryEnv(env)||
    env.AX2_PUBLIC_DISPOSABLE_RUNNER!=="true"||!Object.hasOwn(PINNED_READER_ASSETS,platform))
  throw Error("Reader asset installation requires the owned disposable public CI runner");
 function attempt(){
  const result=run(process.execPath,[CLI,"install"],{cwd:TOOLING,encoding:"utf8",maxBuffer:1024*1024,
   stdio:["ignore","pipe","pipe"],env});
  // Keep the installer's own output in the job log.
  write(String(result.stdout??"")+String(result.stderr??""));
  return result;
 }
 function succeeded(result){return result.status===0&&!result.signal&&!result.error;}
 const first=attempt();
 if(succeeded(first))return {attempts:1};
 const output=String(first.stdout??"")+String(first.stderr??"");
 const asset=PINNED_READER_ASSETS[platform];
 const transientDownload=!first.signal&&!first.error&&first.status!==null&&first.status!==0&&
  output.includes(`Failed to download Guidepup cache asset: ${asset}`)&&
  (output.includes("Cause: TypeError: fetch failed")||
   output.includes(`Cause: Error: Failed to download Guidepup cache asset: ${asset} (504 )`));
 if(!transientDownload)throw Error("Reader asset installation failed; no permitted recovery");
 await wait(2000);
 if(!succeeded(attempt()))throw Error("Reader asset installation remained unavailable");
 return {attempts:2};
}
/** Whether node was asked to run this file: compared as real paths, so a link matches and an import does not. */
function isProgram(){
 try{return Boolean(process.argv[1])&&realpathSync(fileURLToPath(import.meta.url))===realpathSync(process.argv[1]);}
 catch{return false;}
}
if(isProgram()){
 installReaderAssets().then(result=>console.log("Reader asset installation completed; attempts="+result.attempts))
  .catch(error=>{console.error(String(error));console.error("Real reader assets are unavailable; actual reader approval is unavailable.");process.exitCode=1;});
}
