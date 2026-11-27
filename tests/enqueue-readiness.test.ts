/**
 * scripts/enqueue_readiness.mjs: the read-only enqueue checker (owner, 27 November 2026). Synthetic GitHub answers
 * only, no network. Each case below is a way an enqueuer could be wrong; the checker must refuse it or ask a reader
 * to look (Codex's review of the queue plan: a stranger's READY, three READY from one family, an edited verdict, a
 * finding only in a line comment, a check from another app).
 */
import { is, part, done } from "./check";
import { judge, parseMail, commitFamilies, verdictOf, REQUIRED_CHECKS, ACTIONS_APP_ID, DEFAULT_MIN_READY } from "../scripts/enqueue_readiness.mjs";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const T = (m: number) => new Date(Date.UTC(2026, 10, 27, 0, m)).toISOString();
const ready = (fam: string, m: number, extra = "") => ({ body: `${fam} review #9 @${HEAD.slice(0, 10)}: READY, sem achados.${extra}`, author_association: "MEMBER", created_at: T(m), updated_at: T(m) });
const changes = (fam: string, head: string, m: number) => ({ body: `${fam} review #9 @${head.slice(0, 10)}: CHANGES, 1 LEVE.`, author_association: "MEMBER", created_at: T(m), updated_at: T(m) });
const runs = () => REQUIRED_CHECKS.map((name: string) => ({ name, status: "completed", conclusion: "success", head_sha: HEAD, app_id: ACTIONS_APP_ID }));
const base = () => ({
  pr: { state: "open", draft: false, base_ref: "main", head_sha: HEAD, mergeable_state: "blocked" },
  commits: [{ message: "fix: thing\n\nClaude-Session: https://claude.ai/code/session_012ST5iabcdef", author: "viniciussucupira" }],
  issueComments: [ready("Claude 2", 1), ready("Claude 3", 2), ready("Claude 6", 3)],
  reviews: [], reviewComments: [], checkRuns: runs(), mainRedOpen: false,
  mailStatus: { hold: false, claimed: false, text: "#9: livre" },
  minReady: 3,
});
const answer = (input: object) => judge(input).answer;

part("the clean case");
is("three READY with no findings, nine checks, mail free: READY", answer(base()), "READY");
is("the default number of READY is the owner's three", DEFAULT_MIN_READY, 3);
is("the families counted", judge(base()).readyFamilies, ["claude-2", "claude-3", "claude-6"]);

part("objective conditions refuse");
is("main-vermelho open", answer({ ...base(), mainRedOpen: true }), "NOT READY");
is("main-vermelho not read", answer({ ...base(), mainRedOpen: null }), "NOT READY");
is("a draft", answer({ ...base(), pr: { ...base().pr, draft: true } }), "NOT READY");
is("a conflict (dirty)", answer({ ...base(), pr: { ...base().pr, mergeable_state: "dirty" } }), "NOT READY");
is("state not computed (unknown)", answer({ ...base(), pr: { ...base().pr, mergeable_state: "unknown" } }), "NOT READY");
is("base other than main", answer({ ...base(), pr: { ...base().pr, base_ref: "claude2/x" } }), "NOT READY");
is("one required check missing", answer({ ...base(), checkRuns: runs().slice(1) }), "NOT READY");
is("one required check failed", answer({ ...base(), checkRuns: runs().map((r, i) => (i ? r : { ...r, conclusion: "failure" })) }), "NOT READY");
is("a required check from another app", answer({ ...base(), checkRuns: runs().map((r, i) => (i ? r : { ...r, app_id: 999 })) }), "NOT READY");
is("a second run of the same name from another app (a look-alike)", answer({ ...base(), checkRuns: [...runs(), { ...runs()[0], app_id: 999 }] }), "NOT READY");
is("a second run of the same name that failed", answer({ ...base(), checkRuns: [...runs(), { ...runs()[0], conclusion: "failure" }] }), "NOT READY");
is("two SUCCESS runs of each check, as after a reopen, still pass", answer({ ...base(), checkRuns: [...runs(), ...runs()] }), "READY");
is("checks of an older head do not count", answer({ ...base(), checkRuns: runs().map((r) => ({ ...r, head_sha: OLD })) }), "NOT READY");
is("checks not read", answer({ ...base(), checkRuns: null }), "NOT READY");
is("comments not read in full", answer({ ...base(), reviewComments: null }), "NOT READY");
is("HOLD active in the mail", answer({ ...base(), mailStatus: parseMail("#9: HOLD por Claude 1 em 2026-11-27T00:00:00.000Z (ativo)") }), "NOT READY");

part("the verdicts that count");
is("only two READY when three are needed", answer({ ...base(), issueComments: base().issueComments.slice(0, 2) }), "NOT READY");
is("two are enough when two are asked", answer({ ...base(), issueComments: base().issueComments.slice(0, 2), minReady: 2 }), "READY");
is("three READY from one family count once", answer({ ...base(), issueComments: [ready("Claude 2", 1), ready("Claude 2", 2), ready("Claude 2", 3)] }), "NOT READY");
is("a stranger's READY never counts", answer({ ...base(), issueComments: [ready("Claude 2", 1), ready("Claude 3", 2), { ...ready("Claude 6", 3), author_association: "NONE" }] }), "NOT READY");
is("the author's own family does not count", answer({ ...base(), issueComments: [ready("Claude 2", 1), ready("Claude 3", 2), ready("Claude 5", 3)] }), "NOT READY");
is("a READY without 'sem achados' does not count (ZA (a))", answer({ ...base(), issueComments: [ready("Claude 2", 1), ready("Claude 3", 2), { ...ready("Claude 6", 3), body: `Claude 6 review #9 @${HEAD.slice(0, 10)}: READY, 1 LEVE que não bloqueia.` }] }), "NOT READY");
is("an edited verdict refuses", answer({ ...base(), issueComments: [ready("Claude 2", 1), ready("Claude 3", 2), { ...ready("Claude 6", 3), updated_at: T(9) }] }), "NOT READY");
is("a CHANGES on this head refuses", answer({ ...base(), issueComments: [...base().issueComments, changes("Claude 7", HEAD, 4)] }), "NOT READY");
is("a later READY of the same family on this head replaces its CHANGES", answer({ ...base(), issueComments: [changes("Claude 6", HEAD, 0), ...base().issueComments] }), "READY");
is("a READY of an older head does not count", answer({ ...base(), issueComments: [ready("Claude 2", 1), ready("Claude 3", 2), { ...ready("Claude 6", 3), body: `Claude 6 review #9 @${OLD.slice(0, 10)}: READY, sem achados.` }] }), "NOT READY");
is("'Nenhum defeito encontrado' is a READY with no findings", answer({ ...base(), issueComments: [ready("Claude 2", 1), ready("Claude 3", 2), { ...ready("Claude 6", 3), body: `**Claude 6 review #9 @${HEAD}: READY. Nenhum defeito encontrado, nem mesmo leve ou mínimo.**` }] }), "READY");
is("'no HIGH/MEDIUM findings' leaves the lower levels open", answer({ ...base(), issueComments: [ready("Claude 2", 1), ready("Claude 3", 2), { ...ready("Claude 6", 3), body: `Claude 6 review #9 @${HEAD.slice(0, 10)}: READY, no HIGH/MEDIUM findings.` }] }), "NOT READY");
is("a report that says it does not count is neither counted nor blocking", answer({ ...base(), issueComments: [...base().issueComments, { body: `**Codex N1 static review of #9 @${HEAD}: READY — no HIGH/MEDIUM/LOW findings. A static report that does not count toward the required reviews**`, author_association: "MEMBER", created_at: T(7), updated_at: T(7) }] }), "CHECK");
is("a vote count is not a verdict", verdictOf({ body: `Claude 1 coord: #9 @${HEAD.slice(0, 10)}, 1 of 2 READY`, author_association: "MEMBER" }, HEAD), null);

part("what only a reader can judge");
is("a CHANGES on an earlier head asks a reader (ZA (d))", answer({ ...base(), issueComments: [changes("Claude 7", OLD, 0), ...base().issueComments] }), "CHECK");
is("a line comment asks a reader", answer({ ...base(), reviewComments: [{ body: "this rounds down", author_association: "MEMBER", created_at: T(5), updated_at: T(5) }] }), "CHECK");
is("a stranger's comment asks a reader", answer({ ...base(), issueComments: [...base().issueComments, { body: "this leaks the key", author_association: "NONE", created_at: T(6), updated_at: T(6) }] }), "CHECK");
is("mail not read asks a reader", answer({ ...base(), mailStatus: null }), "CHECK");
is("a CLAIMED in the mail asks a reader", answer({ ...base(), mailStatus: parseMail("#9: CLAIMED por Claude 4 em 2026-11-27T00:00:00.000Z (ativo)") }), "CHECK");
is("a commit without a session trailer asks a reader", answer({ ...base(), commits: [{ message: "fix", author: "someone" }] }), "CHECK");

part("a real pull request: #5487 @439899c4fc, read on 27/11/2026 (first lines of each comment as written)");
{
  const H = "439899c4fcf97463877afd8e43687a82bad29501";
  const c = (body: string, at: string) => ({ body, author_association: "MEMBER", created_at: at, updated_at: at });
  const real = {
    pr: { state: "open", draft: false, base_ref: "main", head_sha: H, mergeable_state: "clean" },
    commits: [
      { message: "#5285 row #3454: RED for four findings\n\nClaude-Session: https://claude.ai/code/session_014YNUxxEw5ECLJrDBwjZRVJ", author: "" },
      { message: "#5285 row #3454: no predicted result in words\n\nClaude-Session: https://claude.ai/code/session_014YNUxxEw5ECLJrDBwjZRVJ", author: "" },
    ],
    issueComments: [
      c("CLAIMED review #5487 @439899c4fc — Claude 6 hsz3 (session 018ZjhH), from the agents' mail", "2026-11-24T05:43:59Z"),
      c("Closed by its opener, Claude 5 ibqho, at 05:47 UTC: I opened it while more than 200 PRs were open", "2026-11-24T05:47:46Z"),
      c(`**Claude 6 review #5487 @${H}: READY. Nenhum defeito encontrado, nem mesmo leve ou mínimo (conferido por Claude 6 hsz3).**\n\nClaude 6 hsz3 (session 018ZjhH)`, "2026-11-24T05:48:25Z"),
      c(`Reopened at 06:42 UTC by Claude 3 yaQt (session \`014YNUxyaQt\`) on the owner's order. The head is unchanged: ${H}, 9/9 \`All checks\` SUCCESS`, "2026-11-24T06:42:36Z"),
      c(`**Codex N1 static review of #5487 @${H}: READY — no HIGH/MEDIUM/LOW findings. A static report that does not count toward the required reviews (transcribed by Claude 3 vyDE)**`, "2026-11-25T14:21:24Z"),
      c(`**Review #5487 @${H}: READY, sem achados (0 findings, no defect of any level, NIT included).** Complete review of \`origin/main...439899c4fc\`.\n\nReviewer: Claude 2 (cloud, session \`01FR6Z1Lcncn7rf1ncpxf8Pc\`)`, "2026-11-26T22:45:31Z"),
    ],
    reviews: [], reviewComments: [],
    checkRuns: [...REQUIRED_CHECKS, ...REQUIRED_CHECKS].map((name: string) => ({ name, status: "completed", conclusion: "success", head_sha: H, app_id: ACTIONS_APP_ID })),
    mainRedOpen: false, mailStatus: { hold: false, claimed: false, text: "#5487: livre" },
  };
  const two = judge({ ...real, minReady: 2 });
  is("#5487: the valid READY are Claude 2 and Claude 6; the author's family (Claude 3) and Codex N1's static report are not counted", two.readyFamilies, ["claude-2", "claude-6"]);
  is("#5487 with 2 READY required: nothing blocks, a reader looks at the static report", [two.answer, two.blocking], ["CHECK", []]);
  is("#5487 with the owner's 3 READY: not ready (2 of 3)", judge({ ...real, minReady: 3 }).answer, "NOT READY");
}

part("helpers");
is("families from commit trailers; merges of main skipped", [...commitFamilies([
  { message: "x\n\nClaude-Session: https://claude.ai/code/session_018ZjhHabc", author: "v" },
  { message: "Merge branch 'main' into claude6/x", author: "v" },
  { message: "y", author: "solrenning-codex" },
]).families].sort(), ["claude-6", "codex"]);
is("pr-status 'livre' is neither HOLD nor CLAIMED", parseMail("#9: livre"), { hold: false, claimed: false, text: "#9: livre" });
is("an expired HOLD does not block", parseMail("#9: HOLD por Claude 1 em 2026-11-20T00:00:00.000Z (expirado ou liberado)")?.hold, false);
is("no line from pr-status is not read", parseMail("erro"), null);

done();
