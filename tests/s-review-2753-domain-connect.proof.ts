/**
 * Durable independent-review proof for PR #2753 at 3c3a5695.
 *
 * These checks deliberately fail on the reviewed head. They describe the
 * minimum documentation corrections needed before a clean review.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const study = readFileSync("docs/domain-connect-study-2026-11-06.md", "utf8");

part("Unknown costs remain unknown");
is("the study does not present unmeasured work as free", study.includes("Study cost: none."), false);

part("The pull-request status names its scope");
is(
  "the opening does not claim that no pull request exists while this study is itself in one",
  study.includes("no pull request was opened"),
  false,
);

part("Vercel verification facts stay within the evidence");
is(
  "the study does not call dynamic verification records rare or necessarily apex-hosted without evidence",
  study.includes("rare, and its host sits at the apex"),
  false,
);

done();
