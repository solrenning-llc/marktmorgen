/**
 * A browser accessibility leg builds the app in the workflow only when one of its scripts serves that build.
 *
 * public-matrix, studio-matrix and product-actions start `next start` in the checkout, so their legs need
 * `node scripts/ci-build.mjs` first. buyer-actions and signup-actions never serve the checkout's build: each
 * script copies the tracked tree into a disposable folder (tests/e2e/reviewed-mail-app.mjs), runs its own full
 * `next build` there and starts `next start` from that copy. A workflow build before them was about two
 * runner-minutes per leg that nothing read (six legs a run), so those two workflows no longer run it.
 *
 * This holds both directions: a leg that serves the checkout's build keeps the build step, and a leg whose
 * scripts all build and serve their own copy does not repeat it. A script changed to serve the checkout
 * again fails here until its workflow builds again (and `next start` would also refuse to start without one).
 */
import { readFileSync } from "node:fs";
import { is, part, done } from "./check";

const MATRICES = ["buyer-actions", "product-actions", "public-matrix", "signup-actions", "studio-matrix"];
const read = (path: string) => readFileSync(path, "utf8");

/** Every e2e script a workflow runs, in order, wherever `node tests/e2e/….mjs` appears (`run:`, `- run:` or a `run: |` block). */
function scripts(workflow: string): string[] {
  return [...workflow.matchAll(/\bnode (tests\/e2e\/[a-z0-9-]+\.mjs)\b/g)].map((m) => m[1]);
}
/** The script starts `next start` from the checkout (root), so it serves the workflow's build. */
const servesCheckout = (text: string) =>
  /join\(root,\s*["'`]node_modules\/next\/dist\/bin\/next["'`]\),\s*["'`]start["'`]/.test(text);
/** Any other way a script could start a server: `next start` in any quoting, or an npm start script. */
const startsSomething = (text: string) => /["'`]start["'`]|npm (run )?start|next start/.test(text);
/** The script builds a disposable copy itself and starts `next start` only from that copy. */
const servesOwnBuild = (text: string) =>
  /reviewedApp=await prepareReviewedMailApp\(root,env\);/.test(text) &&
  /join\(reviewedApp\.root,"node_modules\/next\/dist\/bin\/next"\),"start"/.test(text) &&
  !servesCheckout(text);

part("the disposable copy runs a full production build of its own");
const reviewed = read("tests/e2e/reviewed-mail-app.mjs");
is("prepareReviewedMailApp copies the tracked tree and runs `next build` in the copy", [
  /execFileSync\('git', \['ls-files', '-z'\]/.test(reviewed),
  /spawn\(process\.execPath,\[join\(folder,'node_modules\/next\/dist\/bin\/next'\),'build'\],\{cwd:folder/.test(reviewed),
  /if \(built\.status !== 0\) throw Error\('Reviewed disposable app failed to build/.test(reviewed),
  /return \{root:folder,cleanup\};/.test(reviewed),
], [true, true, true, true]);

part("each accessibility matrix builds in the workflow exactly when a script serves the checkout's build");
for (const name of MATRICES) {
  const workflow = read(`.github/workflows/accessibility-${name}.yml`);
  const run = scripts(workflow);
  const texts = run.map(read);
  const builds = (workflow.match(/\bnode scripts\/ci-build\.mjs\b/g) ?? []).length;
  const needsCheckoutBuild = texts.some(servesCheckout);
  is(`${name}: runs its browser script`, run.includes(`tests/e2e/accessibility-${name}.mjs`), true);
  is(`${name}: every script either serves the checkout's build or builds and serves its own copy`,
    texts.map((text) => servesCheckout(text) || servesOwnBuild(text) || !startsSomething(text)), texts.map(() => true));
  is(`${name}: one workflow build when a script serves the checkout's build, none otherwise`, builds, needsCheckoutBuild ? 1 : 0);
  if (needsCheckoutBuild) {
    const buildAt = workflow.indexOf("node scripts/ci-build.mjs");
    const firstServing = run.findIndex((script, i) => servesCheckout(texts[i]));
    is(`${name}: the build comes before the first script that serves it`,
      buildAt >= 0 && buildAt < workflow.indexOf(`node ${run[firstServing]}`), true);
  }
}

part("the two workflows that no longer build are the ones whose scripts serve their own copy");
is("buyer-actions and signup-actions build and serve their own copy; the other three serve the checkout", MATRICES.map((name) => {
  const text = read(`tests/e2e/accessibility-${name}.mjs`);
  return [name, servesOwnBuild(text), servesCheckout(text)];
}), [
  ["buyer-actions", true, false], ["product-actions", false, true], ["public-matrix", false, true],
  ["signup-actions", true, false], ["studio-matrix", false, true],
]);

done();
