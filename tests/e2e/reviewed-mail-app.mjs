/** Build a separate disposable app with a named synthetic account fixture.
 * Production is built/checked first by the caller and remains byte-identical.
 * This changes exactly one transport import in a copy, never the guard, its
 * null production reviews, or a production config/environment switch.
 */
import {execFileSync, spawn} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, readFile, rm, realpath, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {createHash} from 'node:crypto';

export async function prepareReviewedMailApp(root, env) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(env.RESEND_API_BASE ?? '') || env.RESEND_API_KEY !== 're_local_only_a_stand_in') throw Error('Disposable loopback mail service required');
  const source = join(root, 'lib/email.ts'), original = await readFile(source, 'utf8');
  const token = 'from "@/lib/resend-fallback-transport";';
  if (original.split(token).length !== 2) throw Error('Reviewed mail import changed; refuse ambiguous fixture build');
  for (const [file, definition] of [['lib/resend-fallback-budget.ts', 'export const CURRENT_RESEND_FALLBACK_REVIEW: ResendFallbackReview | null = null;'],
      ['lib/resend-fallback-transport.ts', 'export const CURRENT_RESEND_CREDENTIAL_BINDING: ResendCredentialBinding | null = null;']]) {
    if (!(await readFile(join(root, file), 'utf8')).includes(definition)) throw Error('Expected closed production review changed');
  }
  const folder = await mkdtemp(join(dirname(root), 'reviewed-mail-app-'));
  const cleanup = () => rm(folder, {recursive:true,force:true});
  try {
    const files = execFileSync('git', ['ls-files', '-z'], {cwd:root,maxBuffer:8_000_000}).toString().split('\0').filter(Boolean);
    // These new harness files may still be untracked during local validation.
    for (const file of ['tests/e2e/reviewed-mail-app.mjs', 'tests/e2e/reviewed-resend-transport.ts']) if (!files.includes(file)) files.push(file);
    for (const file of files) {
      if (file.startsWith('/') || file.split('/').includes('..')) throw Error('Unsafe tracked path');
      await mkdir(dirname(join(folder,file)), {recursive:true});
      await copyFile(join(root,file),join(folder,file));
    }
    // Hard links keep dependency files inside Turbopack's isolated root;
    // deleting this build removes directory entries, never the originals.
    execFileSync('cp',['-al',await realpath(join(root,'node_modules')),join(folder,'node_modules')]);
    await writeFile(join(folder,'lib/email.ts'),original.replace(token,'from "@/tests/e2e/reviewed-resend-transport";'));
    const built = await new Promise((resolve,reject) => {
      const child=spawn(process.execPath,[join(folder,'node_modules/next/dist/bin/next'),'build'],{cwd:folder,env,stdio:['ignore','pipe','pipe']});
      let output='';for (const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>output=(output+chunk).slice(-8000));
      child.once('error',reject);child.once('close',status=>resolve({status,output}));
    });
    if (built.status !== 0) throw Error('Reviewed disposable app failed to build:\n'+built.output);
    if (await readFile(source,'utf8') !== original) throw Error('Production source changed during fixture build');
    console.log('SYNTHETIC_REVIEWED_MAIL_BUILD:'+JSON.stringify({productionEmailSha256:createHash('sha256').update(original).digest('hex'),transformedImports:1,realTransport:true,budgetLua:'proved separately; browser uses explicit ACK fixture',productionReview:'null, unchanged'}));
    return {root:folder,cleanup};
  } catch(error) {await cleanup();throw error;}
}
