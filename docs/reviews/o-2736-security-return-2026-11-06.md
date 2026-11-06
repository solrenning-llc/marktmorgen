# PR #2736 — second security review return (Codex O)

Verdict: **NO FINDING / MAY MERGE**, limited to the assigned security correction. This closes M1, M2 and M3 of CX1's original review; it does not certify CI or authorize merging without the required checks and first security review.

Reviewed head: `087601cb95529a4b0c3ea1755f4ba9abf43a02e5` (`claude6/wg12-signin-code`). Assigned delta: `6fa03a48..7b81caa5`, C4-2710. Announcement preceded diff and tests: PR comment 6693693296; channel confirmation commit a066ab659621da93b739af84ad735fb2db0320dc. Claude 4 is the coordinator. No author branch, product, assertion or CI mutation.

## Identity and scope

The four correction paths were read: lib/auth.ts, tests/cx1-review-2736-security.test.ts, tests/wg12-signin-code.test.ts and the EMAIL_CODE_TRIES entry in tests/plan-cost-registry.ts. The request/code routes, finishProvenSignIn, secret-box key derivation and exact-reply helpers were checked as dependencies.

The following product/test blobs are identical between correction 7b81caa5 and reviewed head 087601cb:

| Path | Blob |
| --- | --- |
| lib/auth.ts | f52b4477d0ae8ad957657fa83207cf579bb0b27a |
| tests/cx1-review-2736-security.test.ts | 683ff9499652326240f986e00a9cf7c42e26fdbf |
| tests/wg12-signin-code.test.ts | 95fa735d3a13de371e619c24e3e09598f878482a |

Do not treat the whole inherited cost registry or the 445 inherited main paths as byte-identical; the relevant cost entry explicitly includes the additional newest-code GET.

## Findings closed

- **M1:** spendLinkKey validates the exact one-element GETDEL envelope and its value. An unknown value cannot become an owner. Its compatibility fallback validates exact GET and DEL replies; only numeric DEL=1 admits the read owner. A lost consume acknowledgment cannot recover the consumed value and admit again. The link and code use this shared spend point.
- **M2:** takeSignInCode reads the newest-code marker again **after** the link's consumption. A newer issuance that completes before the old consume is therefore refused, with no session. An unknown post-consume marker also admits no owner. The permanent proof interposes an actual newer issuance immediately before consumption and verifies both refusal of the old code and usability of the new code. This is not a claim that the two Redis commands form an atomic transaction.
- **M3:** codeHash uses HMAC-SHA256 with deriveKey("auth-email-code/v1"), separating the verifier secret from Redis. No deployment secret means no issued code, preserving the link-only path. The request id alone no longer lets the unchanged original attack recover a usable code by enumerating six digits. This is a conditional database-read threat model, not a claim of a public-route-only exploit or proof against every attack.

The code route retains the shared finishProvenSignIn path and its two-step behavior. The additional post-consume read is listed in EMAIL_CODE_TRIES and remains behind the existing request/address/machine attempt admission; this review does not change limits or claim an independent total-company margin audit.

## Independent reproduction

Original immutable proof: `2b2e8c10f968e28889dfdfd50ad65a6bec6128df:tests/cx1-review-2736-security.proof.ts`.

Current permanent proof is byte-identical, SHA256 `87bbd28bb5cd772ec1d800c578c1a93b4d0d55b818781f849111ee51bd58544b`.

- **RED:** unchanged original eight assertions, replacing only lib/auth.ts during esbuild onLoad with its exact git blob at 6fa03a48; current routes/dependencies/fixtures held constant. Result **8 checks / 3 causal failures / 5 controls**, exit 1. This is an old-auth substitution experiment, not a complete checkout execution of the old repository.
- **GREEN:** same proof and harness against the reviewed current source: **8/8**, exit 0.
- The three RED failures each opened a real synthetic session: malformed consume envelope, newer issuance before consume, and offline verifier enumeration. The GREEN run closed all three while retaining the positive session and newest-code controls.

Reproduction command, run from the reviewed checkout with installed repository dependencies (no production credentials):

~~~js
// node --input-type=module
import {build} from 'esbuild';
import {testAliases,testEnvironment} from './tests/test-config.mjs';
import {resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const root=process.cwd(),file='cx1-review-2736-security.test.ts';
const original=execFileSync('git',['show','2b2e8c10f968e28889dfdfd50ad65a6bec6128df:tests/cx1-review-2736-security.proof.ts'],{encoding:'utf8'});
if(original!==readFileSync('tests/'+file,'utf8'))throw Error('Proof bytes changed');
const oldAuth=execFileSync('git',['show','6fa03a48:lib/auth.ts'],{encoding:'utf8'});
for(const old of [true,false]){
 const outfile='/tmp/o2736-'+(old?'red':'green')+'.cjs';
 await build({entryPoints:[resolve('tests',file)],bundle:true,platform:'node',format:'cjs',outfile,alias:testAliases(file,root,resolve('tests')),logLevel:'error',plugins:old?[{name:'exact-old-auth',setup(b){b.onLoad({filter:/\\/lib\\/auth\\.ts$/},()=>({contents:oldAuth,loader:'ts'}));}}]:[]});
 const run=spawnSync(process.execPath,[outfile],{cwd:root,env:testEnvironment(process.env),encoding:'utf8'});
 console.log(old?'RED':'GREEN',run.status,run.stdout,run.stderr);
 if(old?run.status===0:run.status!==0)throw Error('Unexpected RED/GREEN');
}
~~~

## Validation on the reviewed head

| Test file | Result |
| --- | --- |
| cx1-review-2736-security.test.ts | 8/8 |
| wg12-signin-code.test.ts | 50/50 |
| auth-mail-unavailable.test.ts | 28/28 |
| two-step.test.ts | 49/49 |
| team-two-step.test.ts | 14/14 |
| team-two-step-session.test.ts | 30/30 |
| invite-two-step.test.ts | 8/8 |
| passkey-signin-response.test.ts | 48/48 |
| google-signin.test.ts | 47/47 |
| sign-in-history-rules.test.ts | 51/51 |
| plan-cost-registry.test.ts | 24/24 |

Total **357/357 assertions**, 11 passing files including the CX1 proof. Linked tests compiled using repository testAliases and ran in separate child processes with testEnvironment.

TypeScript strict directed roots lib/auth.ts, lib/signin-finish.ts, app/api/auth/email-code/route.ts and the two security/code tests, with transitive imports: **0 diagnostics**. ESLint on those five paths: exit 0. scripts/check_public_data.py: **4075 tracked files / 0 requiring correction**. git diff --check 6fa03a48 7b81caa5: exit 0.

All identities, email, Redis and requests were synthetic; the CX1 proof rejects unexpected external fetch. No native Redis/Upstash, supplier email, real account, browser/AAA matrix, human accessibility testing, global suite or nine CI checks is certified here. The PR description still describes the original plain hash; the author should update it to the final keyed HMAC behavior.
