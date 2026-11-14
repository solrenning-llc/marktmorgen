/**
 * How "Mobile render (candidate)" judges one cold sample (tests/e2e/mobile-render-judge.mjs), decided by Claude 2
 * (coordinator) on 13 November 2026 after five unrelated PRs failed on a single slow sample each.
 *
 * The bounds stay exactly as strict: LCP under 2,500 ms, CLS under 0.1, interaction-to-paint under 200 ms, on every
 * sample. Only a sample whose one miss is interaction-to-paint is measured again, once, on the same page under the
 * same throttling; it passes only if the second measure is under 200 ms. LCP, CLS, a write or a missing measure are
 * never measured again. Every miss is said (page, sample, target, value, bound), never failed silently.
 */
import * as judge from "./e2e/mobile-render-judge.mjs";
import { done, is, part } from "./check";

type Sample = { label: string; path: string; sample: number; apiWrites: number; lcpMs: number | null; cls: number | null; interactionToPaintMs: number | null };
type Verdict = { verdict: "pass" | "retry" | "fail"; misses: { target: string; value: number | null; bound: number }[]; reason?: string };
const judgeSample = (judge as unknown as { judgeSample?: (s: Sample, attempt: number) => Verdict }).judgeSample;

const sample = (over: Partial<Sample> = {}): Sample => ({ label: "candidate", path: "/pricing", sample: 1, apiWrites: 0, lcpMs: 700, cls: 0, interactionToPaintMs: 48, ...over });
const run = (s: Sample, attempt: number) => (judgeSample ? judgeSample(s, attempt) : { verdict: "missing" as const, misses: [] });

function main(): void {
  part("A sample inside every bound passes");
  is("there is a judge", typeof judgeSample, "function");
  is("passes", run(sample(), 1).verdict, "pass");

  part("Interaction-to-paint missed once: measured again once, and passes only under 200 ms");
  const slow = run(sample({ interactionToPaintMs: 213 }), 1);
  is("measured again", slow.verdict, "retry");
  is("the miss is said with its value and bound", slow.misses, [{ target: "interaction", value: 213, bound: 200 }]);
  is("the second measure under 200 ms passes", run(sample({ interactionToPaintMs: 61 }), 2).verdict, "pass");
  is("missed twice fails", run(sample({ interactionToPaintMs: 202 }), 2).verdict, "fail");
  is("exactly 200 ms is a miss", run(sample({ interactionToPaintMs: 200 }), 1).verdict, "retry");

  part("LCP, CLS, writes and missing measures are never measured again");
  is("an LCP miss fails at once", run(sample({ lcpMs: 2600 }), 1).verdict, "fail");
  is("a CLS miss fails at once", run(sample({ cls: 0.12 }), 1).verdict, "fail");
  is("an LCP miss with a slow interaction fails at once too", run(sample({ lcpMs: 2600, interactionToPaintMs: 300 }), 1).verdict, "fail");
  is("a write fails at once", run(sample({ apiWrites: 1 }), 1).verdict, "fail");
  is("no interaction measured fails at once", run(sample({ interactionToPaintMs: null }), 1).verdict, "fail");
  is("no LCP measured fails at once", run(sample({ lcpMs: null }), 1).verdict, "fail");
  const failed = run(sample({ cls: 0.12 }), 1);
  is("and the miss is said, never silent", failed.misses, [{ target: "cls", value: 0.12, bound: 0.1 }]);

  part("A baseline run is measured, never judged by the bounds");
  is("passes whatever its numbers", run(sample({ label: "baseline", interactionToPaintMs: 400, lcpMs: 3000 }), 1).verdict, "pass");
  is("but a write still fails it", run(sample({ label: "baseline", apiWrites: 1 }), 1).verdict, "fail");
  done();
}

main();
