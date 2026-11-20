// The agents' coordination channel rolls over before GitHub closes it (owner, 20/11/2026, about 03h Fortaleza).
//
// GitHub refuses comments on an issue past 2,500. The open issue labeled canal-ativo is the channel; when it reaches
// ROLL_AT comments this opens the next part (or uses one an agent already opened by hand with the same title), writes
// the first comment there explaining the change and the label rule, puts one pointer line at the top of the previous
// part's body, changes the PAINEL's first line and moves the label LAST, so a failure at any earlier step leaves the
// channel where it was and the next comment's run finishes the same rollover. Every step is idempotent.
//
// It never closes or locks an issue and never deletes, edits or hides a comment, with one exception the owner decided
// (20/11/2026): the PAINEL's first line, and only that line. The PAINEL is found by its fixed id AND its fixed mark; its
// first line must be "#N" or "Canal ativo: #N" (any case, bold or not); otherwise the PAINEL is not edited, the channel
// still rolls over completely (it must never fill), the new part's first comment says why with the first line found, and
// the run ends with a warning annotation, not a failure (owner, 20/11/2026 18h23). The PAINEL is re-read
// just before the write, its current first line is kept in the new part first (to undo), the write is never repeated
// blindly, and it is read back: every other byte must be the same. The text of the comment that triggered a run never
// reaches this script, and only this workflow's own comments count as its markers.
//
// MODE "dry-run" (the manual run's default) only reads and prints what a rollover would do, at any count.
// Run by .github/workflows/coordination-rollover.yml; held by tests/coordination-rollover.test.ts.

/** @typedef {(method: string, path: string, body?: unknown) => Promise<any>} Api */

export const LABEL = "canal-ativo";
/** GitHub's limit: no comment is accepted on an issue past this. */
export const COMMENT_LIMIT = 2500;
/** 250 comments of room: at about 100 comments an hour, two hours and a half before the limit. */
export const ROLL_AT = 2250;
/** The PAINEL DA FILA, comment 6929670678 on #4827; its first line names the active part. */
export const PANEL_COMMENT_ID = 6929670678;
/** A fixed mark only the PAINEL has; with the fixed id, it makes the PAINEL the only comment this script edits. */
export const PANEL_MARK = "PAINEL DA FILA";
/** GitHub's limit on an issue or comment body. */
export const BODY_LIMIT = 65536;
/** Who may have opened a part this script adopts: never an outside account of a public repository. */
export const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
/** The account this workflow writes as; only its comments count as the workflow's own markers. */
export const BOT = "github-actions[bot]";
const FIND = "gh issue list --label canal-ativo --state open";
const MARKER = "<!-- coordination-rollover: first comment -->";
const WARN_MARKER = "<!-- coordination-rollover: panel warning -->";
const UNDO_MARKER = "<!-- coordination-rollover: panel line kept -->";
const POINTER = /^\*\*Canal ativo: #(\d+)\*\*/;
/** The PAINEL's first line: "#N" or "Canal ativo: #N"; an old "(parte P), desde ... (Fortaleza)" after it is kept in step. */
const PANEL_LINE = /^(\**\s*(?:canal ativo: )?)#(\d+)( \(parte \d+\), desde [^)]*\))?/i;
const PAGES = 25;
/** The longest wait for one GitHub reply. */
export const REQUEST_MS = 20000;

/** The part number in "Agent coordination — part 7 (continues #4858)", or null. */
export function partOf(title) {
  const m = /^Agent coordination — part (\d+)(?: \(continues #\d+\))?$/.exec(String(title ?? ""));
  return m ? Number(m[1]) : null;
}

export const nextTitle = (part, previous) => `Agent coordination — part ${part + 1} (continues #${previous})`;

/** The part this one continues, from its title "(continues #M)", or null. */
export const previousOf = (title) => { const m = /\(continues #(\d+)\)$/.exec(String(title ?? "")); return m ? Number(m[1]) : null; };

/**
 * The line on top of the previous part. While the label has not moved yet ("pending"), it says to keep writing here, so
 * agents' comments keep coming and each retries the rollover; once the label moved, it says the part is closed for
 * coordination.
 */
export const pointerLine = (next, pending = false) => pending
  ? `**Canal ativo: #${next}** (opening: keep writing here until the label \`${LABEL}\` moves there; check with \`${FIND}\`).`
  : `**Canal ativo: #${next}** (this part no longer takes coordination; find the current part with \`${FIND}\`).`;

/** The body with the pointer line on top; an older pointer line of this script is replaced, nothing else changes. */
export function withPointer(body, next, pending = false) {
  const text = body ?? "";
  const line = pointerLine(next, pending);
  if (POINTER.test(text)) {
    const end = text.indexOf("\n");
    return line + (end < 0 ? "" : text.slice(end));
  }
  return text ? line + "\n\n" + text : line;
}

/** The part a pointer line at the top of a body names, or null. */
export const pointedTo = (body) => { const m = POINTER.exec(String(body ?? "")); return m ? Number(m[1]) : null; };

/** Opened by the workflow itself or by someone with write access, never by an outside account. */
export const trusted = (issue) => TRUSTED.has(issue?.author_association) || issue?.user?.login === BOT;

/** Only this workflow's own comments count: in a public repository anyone can post a comment with the same marker. */
const byBot = (comment) => comment?.user?.login === BOT;

/** "DD/MM/YYYY HHhMM" in Fortaleza, UTC−3 with no daylight saving time. */
export function fortaleza(date) {
  const d = new Date(date.getTime() - 3 * 3600 * 1000);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${two(d.getUTCHours())}h${two(d.getUTCMinutes())}`;
}

/** A body's first line. */
export const firstLine = (body) => { const text = String(body ?? ""); const end = text.indexOf("\n"); return end < 0 ? text : text.slice(0, end); };

/** Why this PAINEL body cannot be edited, or null when it carries the mark and its first line has the expected format. */
export function panelProblem(body) {
  if (typeof body !== "string") return "the PAINEL comment could not be read";
  if (!body.includes(PANEL_MARK)) return `comment ${PANEL_COMMENT_ID} no longer carries the mark "${PANEL_MARK}"`;
  if (!PANEL_LINE.test(firstLine(body))) return `the PAINEL's first line is not "#N" or "Canal ativo: #N"`;
  return null;
}

/** The PAINEL with only its first line naming the new part; every other byte stays the same, or it throws. */
export function panelWith(body, next, part, now) {
  const problem = panelProblem(body);
  if (problem) throw new Error(problem + "; not guessing where to write");
  const first = firstLine(body);
  const rest = body.slice(first.length);
  const m = PANEL_LINE.exec(first);
  if (Number(m[2]) === next) return body;
  const line = m[1] + "#" + next + (m[3] ? ` (parte ${part}), desde ${fortaleza(now)} (Fortaleza)` : "") + first.slice(m[0].length);
  if (line.includes("\n")) throw new Error("the PAINEL's new first line would span lines");
  const out = line + rest;
  if (out.slice(line.length) !== rest) throw new Error("the PAINEL would change beyond its first line");
  return out;
}

/** A fence longer than any run of backticks in the text, so the kept line is exactly the old one. */
export function fenced(text) {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return fence + "text\n" + text + "\n" + fence;
}

function newPartBody(active, count, now) {
  return [
    `Continuation of #${active.number} (${active.title}), which reached ${count} comments on ${fortaleza(now)} Fortaleza. ` +
      `GitHub refuses comments past ${COMMENT_LIMIT.toLocaleString("en-US")}, so this part was opened by the coordination rollover workflow before that.`,
    `Everything that held in #${active.number} holds here unchanged: the rules, the IDs and the formats. Cite earlier comments by their id.`,
    `The channel is always the one open issue labeled \`${LABEL}\`: check it with \`${FIND}\` before every write. ` +
      `The PAINEL DA FILA (comment ${PANEL_COMMENT_ID} on #4827) names it on its first line.`,
  ].join("\n\n");
}

function firstComment(active, next, panelBody, problem = null) {
  return [
    MARKER,
    `**The coordination channel moved: #${active.number} is nearly full; the active channel is #${next}.**`,
    `Before you write in the channel, check which issue has the label \`${LABEL}\`: \`${FIND}\`. The label is on one issue only, and this ` +
      `workflow moves it before each part fills, with a pointer line on top of the previous part and the PAINEL's first line updated.`,
    ...(problem ? panelNotUpdated(problem, panelBody)
      : [`To undo the PAINEL change, put back its first line (comment ${PANEL_COMMENT_ID}) as it was before this rollover:`, fenced(firstLine(panelBody))]),
  ].join("\n\n");
}

const undoNote = (line) => [UNDO_MARKER, `The PAINEL's first line (comment ${PANEL_COMMENT_ID}) right before this rollover changed it, to undo:`,
  fenced(line)].join("\n\n");

/** What a new part says when its rollover could not update the PAINEL (owner, 20/11/2026 18h23): why, and the line found. */
function panelNotUpdated(problem, panelBody) {
  return [
    `**The PAINEL was not updated by this rollover** (comment ${PANEL_COMMENT_ID}): ${problem}. The channel itself rolled over: the label \`${LABEL}\` shows where.`,
    ...(typeof panelBody === "string" ? ["Its first line, as this run found it:", fenced(firstLine(panelBody))] : ["Its first line could not be read."]),
    `The coordinator fixes the PAINEL's first line by hand. The workflow edits it only when it is "#N" or "Canal ativo: #N" and the comment carries "${PANEL_MARK}".`,
  ];
}

function panelWarning(problem) {
  return [
    WARN_MARKER,
    `**Coordination rollover left the PAINEL as it is:** ${problem}.`,
    `The workflow edits only the first line of the PAINEL (comment ${PANEL_COMMENT_ID}), and only when it is "#N" or "Canal ativo: #N" and the ` +
      `comment carries "${PANEL_MARK}". The channel itself rolled over: the label \`${LABEL}\` shows where. Fix the PAINEL's first line by hand.`,
  ].join("\n\n");
}

function list(value, what) {
  if (!Array.isArray(value)) throw new Error(`unreadable ${what}: ${JSON.stringify(value)?.slice(0, 300)}`);
  return value;
}

/** Every page of a listing, up to PAGES pages of 100; `enough(page)` stops early once later pages cannot matter. */
async function all(api, path, what, enough = (_page) => false) {
  const items = [];
  for (let page = 1; page <= PAGES; page += 1) {
    const found = list(await api("GET", `${path}&per_page=100&page=${page}`), what);
    items.push(...found);
    if (found.length < 100 || enough(found)) return items;
  }
  throw new Error(`more than ${PAGES} pages of ${what}`);
}

function fits(body, what) {
  if (body.length > BODY_LIMIT) throw new Error(`${what} would pass GitHub's ${BODY_LIMIT}-character limit`);
  return body;
}

/** The PAINEL and why it cannot be edited (null when it can); a deleted PAINEL is a problem, any other failure throws. */
async function readPanel(api) {
  let panel;
  try {
    panel = await api("GET", `issues/comments/${PANEL_COMMENT_ID}`);
  } catch (error) {
    if (/HTTP 404/.test(String(error))) return { body: null, problem: `comment ${PANEL_COMMENT_ID} (the PAINEL) was not found` };
    throw error;
  }
  const body = typeof panel?.body === "string" ? panel.body : null;
  return { body, problem: panelProblem(body) };
}

/** The comments on an issue's two newest pages: enough to find what this workflow wrote there in its last runs. */
async function newest(api, number) {
  const issue = await api("GET", `issues/${number}`);
  const last = Math.max(1, Math.ceil((Number.isSafeInteger(issue?.comments) ? issue.comments : 0) / 100));
  const found = [];
  for (const page of new Set([Math.max(1, last - 1), last])) {
    found.push(...list(await api("GET", `issues/${number}/comments?per_page=100&page=${page}`), "newest comments"));
  }
  return found;
}

/** One warning in an issue, not repeated by later runs: this workflow's own comments on its two newest pages. */
export async function warnOnce(api, number, problem) {
  if ((await newest(api, number)).some((c) => byBot(c) && String(c?.body ?? "").startsWith(WARN_MARKER))) return;
  await api("POST", `issues/${number}/comments`, { body: panelWarning(problem) });
}

/**
 * Writes the pointer line on top of an issue's body as it is NOW (read just before), so no edit made meanwhile is lost.
 * The PATCH is never repeated with an old text: after a failure the body is read again and the line computed again.
 */
async function putPointer(api, number, next, pending) {
  for (let attempt = 0; ; attempt += 1) {
    const fresh = await api("GET", `issues/${number}`);
    const body = fresh?.body ?? "";
    const target = fits(withPointer(body, next, pending), `#${number}'s body`);
    if (target === body) return;
    try {
      await api("PATCH", `issues/${number}`, { body: target });
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}

/**
 * After a rollover whose very last write (the final pointer line) failed, a manual run finishes it: the previous part
 * still says "opening: keep writing here" about the part that now has the label. Returns that part's number, or null.
 */
async function finishPointer(api, active) {
  const previous = previousOf(active.title);
  if (previous === null) return null;
  const issue = await api("GET", `issues/${previous}`);
  const body = issue?.body ?? "";
  if (pointedTo(body) !== active.number || !body.startsWith(pointerLine(active.number, true))) return null;
  await putPointer(api, previous, active.number, false);
  return previous;
}

/**
 * After a rollover whose PAINEL edit did not apply, a manual run finishes it: the PAINEL still names the part this one
 * continues. Returns null when nothing is left to do, "done" once changed, or why it could not be changed.
 */
async function finishPanel(api, active, part, now) {
  const panel = await readPanel(api);
  if (panel.problem) return null;
  const named = Number(PANEL_LINE.exec(firstLine(panel.body))?.[2]);
  if (named === active.number || named !== previousOf(active.title)) return null;
  const left = await editPanel(api, active.number, part, now, await newest(api, active.number));
  return left ?? "done";
}

/**
 * The PAINEL step: re-read just before the write, keep its current first line in the new part first, change only that
 * line, never repeat the write blindly, and read it back. Returns why it is unchanged or unverified, or null when done.
 */
async function editPanel(api, next, part, now, comments) {
  const fresh = await readPanel(api);
  if (fresh.problem) return fresh.problem;
  const target = panelWith(fresh.body, next, part, now);
  if (target === fresh.body) return null;
  let line = firstLine(fresh.body);
  if (!comments.some((c) => byBot(c) && String(c?.body ?? "").includes(fenced(line)))) {
    await api("POST", `issues/${next}/comments`, { body: undoNote(line) });
    // Read again right before the write: nothing else is written between that read and the PATCH.
    const again = await readPanel(api);
    if (again.problem) return again.problem;
    if (firstLine(again.body) !== line) return `the PAINEL's first line changed while this run was keeping it (it is kept in #${next}); it is unchanged`;
    fresh.body = again.body;
    line = firstLine(again.body);
  }
  const write = panelWith(fresh.body, next, part, now);
  let failed = "";
  try {
    await api("PATCH", `issues/comments/${PANEL_COMMENT_ID}`, { body: write });
  } catch (error) {
    failed = String(error);
  }
  const after = await readPanel(api);
  if (after.body === write) return null;
  if (after.body === fresh.body) return `the PAINEL edit did not apply${failed ? ` (${failed})` : ""}; it is unchanged`;
  return "the PAINEL changed while this run was editing its first line; check by hand that nothing anyone wrote was lost " +
    `(its first line before this run is kept in #${next})`;
}

/**
 * One rollover check; returns { action: "none" | "finished" | "dry-run" | "rolled" }. Throws on anything it cannot read.
 * Every read and check comes before the first write. The order of the writes keeps a retry finishing the same
 * rollover: the next part, then the pointer on the active part (which records the next part's number for a retry),
 * then the first comment, the PAINEL, and the label last; the label is what agents follow, so until it moves they
 * keep writing in the active part and each of their comments retries. A dry run stops after the reads and prints the plan.
 * A PAINEL that cannot be edited never stops the rollover (the channel must not fill): the PAINEL is left as it is, the
 * new part says why (with the first line found) and the result carries `panelLeft`, which main() turns into a warning.
 * @param {{ api: Api, now: Date, log?: (line: string) => void, dryRun?: boolean,
 *   event?: null | { issue?: string, labeled?: string, pullRequest?: string, count?: string, atRoll?: string } }} options
 */
export async function rollover({ api, now, log = console.log, dryRun = false, event = null }) {
  const labeled = list(await api("GET", `issues?labels=${LABEL}&state=all&per_page=100`), "labeled issue listing")
    .filter((i) => !i?.pull_request);
  if (labeled.length !== 1) throw new Error(`exactly one issue must have the label ${LABEL}; found ${labeled.length}: ${labeled.map((i) => "#" + i?.number).join(", ")}. ` +
    "Fix the label by hand, then run the workflow by hand (Actions, Coordination rollover, Run workflow).");
  const active = labeled[0];
  const part = partOf(active.title);
  if (!Number.isSafeInteger(active.number) || active.state !== "open" || part === null || !Number.isSafeInteger(active.comments)) {
    throw new Error(`the labeled issue is not an open coordination part: ${JSON.stringify({ number: active.number, state: active.state, title: active.title })}`);
  }
  if (event) {
    log(`GitHub evaluated for this event: issue #${event.issue}, labeled ${LABEL}: ${event.labeled}, pull request: ${event.pullRequest}, ` +
      `comments: ${event.count}, at or above ${ROLL_AT}: ${event.atRoll}`);
  }
  const atRoll = active.comments >= ROLL_AT;
  if (!atRoll && !dryRun) {
    // Below the count there is no rollover to do; a manual run in mode run finishes what the last one could not.
    const finished = await finishPointer(api, active);
    const panelLeft = await finishPanel(api, active, part, now);
    log(`#${active.number} (part ${part}) has ${active.comments} comments, below ${ROLL_AT}: nothing to roll over` +
      (finished ? `; the line on top of #${finished} now says it no longer takes coordination` : "") +
      (panelLeft === null ? "" : panelLeft === "done" ? "; the PAINEL's first line now names it" : `; the PAINEL: ${panelLeft}`));
    const left = panelLeft !== null && panelLeft !== "done" ? panelLeft : null;
    return { action: finished || panelLeft === "done" ? "finished" : "none", active: active.number, ...(left ? { panelLeft: left } : {}) };
  }

  // Reads and checks, all before any write.
  const title = nextTitle(part, active.number);
  const pointed = pointedTo(active.body);
  let next = null;
  if (pointed !== null) {
    const issue = await api("GET", `issues/${pointed}`);
    if (issue?.title !== title || issue.state !== "open" || issue.pull_request || !trusted(issue)) {
      throw new Error(`#${active.number} points to #${pointed}, which is not an open "${title}" opened from inside the repository`);
    }
    next = issue;
  } else {
    // Newest first; a part opened after the active one has a higher number, so the pages stop at the active part.
    // By number, once: a page boundary can repeat an item when an issue is opened during the read.
    const listed = await all(api, "issues?state=open&sort=created&direction=desc", "open issue listing",
      (page) => page.some((i) => Number(i?.number) <= active.number));
    const found = [...new Map(listed.filter((i) => !i?.pull_request && i?.title === title && trusted(i)).map((i) => [i.number, i])).values()];
    if (found.length > 1) throw new Error(`more than one open "${title}": ${found.map((i) => "#" + i.number).join(", ")}`);
    next = found[0] ?? null;
  }
  const panel = await readPanel(api);
  const PROBE = 99999999;
  if (!panel.problem) fits(panelWith(panel.body, PROBE, part + 1, now), "the PAINEL");
  fits(withPointer(active.body, PROBE, true), `#${active.number}'s body`);
  fits(withPointer(active.body, PROBE), `#${active.number}'s body`);

  if (dryRun) {
    const n = next?.number ?? "N";
    const plan = [
      `dry run: nothing is written. #${active.number} (part ${part}) has ${active.comments} comments; a rollover ${atRoll ? "is due now" : `starts at ${ROLL_AT}`}. It would:`,
      next ? `1. use #${next.number}, already open: "${title}"` : `1. open "${title}" (#N)`,
      `2. put on top of #${active.number}: ${pointerLine(n, true)}`,
      `3. write #${n}'s first comment` + (panel.problem ? "" : `, keeping the PAINEL's current first line: ${firstLine(panel.body)}`),
      panel.problem ? `4. NOT change the PAINEL (${panel.problem}); say so in #${n}'s first comment, with its first line as found, and end with a warning`
        : `4. change the PAINEL's first line to: ${firstLine(panelWith(panel.body, next?.number ?? PROBE, part + 1, now)).replace(String(PROBE), "N")}`,
      `5. move the label ${LABEL} from #${active.number} to #${n}, then make the line on #${active.number}: ${pointerLine(n)}`,
    ];
    for (const line of plan) log(line);
    return { action: "dry-run", active: active.number, next: next?.number ?? null, due: atRoll, plan, ...(panel.problem ? { panelLeft: panel.problem } : {}) };
  }

  // Writes.
  const opened = !next;
  if (opened) next = await api("POST", "issues", { title, body: newPartBody(active, active.comments, now) });
  if (!Number.isSafeInteger(next?.number)) throw new Error("the next part has no number: " + JSON.stringify(next)?.slice(0, 300));
  log(opened ? `opened #${next.number}` : `using #${next.number}, already open`);

  await putPointer(api, active.number, next.number, true);

  const comments = await all(api, `issues/${next.number}/comments?sort=created`, "next part's comments");
  let toldInFirst = false;
  if (!comments.some((c) => byBot(c) && String(c?.body ?? "").startsWith(MARKER))) {
    const body = firstComment(active, next.number, panel.body, panel.problem);
    await api("POST", `issues/${next.number}/comments`, { body });
    comments.push({ body, user: { login: BOT } });
    toldInFirst = Boolean(panel.problem);
  }

  const panelLeft = panel.problem ?? await editPanel(api, next.number, part + 1, now, comments);

  // The switch itself, last: never two issues with the label, and back on the old one if the new one refuses it.
  try {
    await api("DELETE", `issues/${active.number}/labels/${LABEL}`);
  } catch (error) {
    // Already gone (a retried DELETE the server had applied) answers 404. Any other failure: read the old part's own
    // labels; if the label is gone the DELETE was applied and the switch goes on, otherwise it stops with the label in place.
    if (!/HTTP 404/.test(String(error))) {
      let still;
      try {
        still = list(await api("GET", `issues/${active.number}/labels`), "old part's labels").some((l) => l?.name === LABEL);
      } catch (unread) {
        throw new Error(`the label DELETE on #${active.number} failed (${String(error)}) and its labels could not be read (${String(unread)}); ` +
          `check by hand that exactly one of #${active.number} and #${next.number} has ${LABEL}`);
      }
      if (still) throw error;
      log(`the label DELETE on #${active.number} answered an error but was applied`);
    }
  }
  try {
    await api("POST", `issues/${next.number}/labels`, { labels: [LABEL] });
  } catch (error) {
    // The add may have been applied with its reply lost: read the new part's own labels (not a listing, which can lag)
    // before putting the label back, so it is never on two issues. If that read fails too, nothing is put back.
    let has;
    try {
      has = list(await api("GET", `issues/${next.number}/labels`), "new part's labels").some((l) => l?.name === LABEL);
    } catch (unread) {
      throw new Error(`the label add on #${next.number} failed (${String(error)}) and its labels could not be read (${String(unread)}); ` +
        `check by hand that exactly one of #${active.number} and #${next.number} has ${LABEL}`);
    }
    if (has) {
      log(`the label add on #${next.number} answered an error but was applied`);
    } else {
      let back = "it is back on #" + active.number;
      try {
        await api("POST", `issues/${active.number}/labels`, { labels: [LABEL] });
      } catch (again) {
        back = `putting it back on #${active.number} failed too (${String(again)}): NO issue has the label; put it on #${next.number} by hand`;
      }
      throw new Error(`the label could not go on #${next.number} (${String(error)}); ${back}`);
    }
  }
  log(`the channel is now #${next.number} (part ${part + 1})`);
  // The label moved: the pointer now says the part is closed for coordination. A failure here leaves the run red with the
  // channel already right (the "opening" line still points to the right part); a manual run in mode run finishes it.
  await putPointer(api, active.number, next.number, false);

  if (panelLeft) {
    // The rollover is complete; only the PAINEL is not. The new part says why (in its first comment, or in one warning
    // when that comment was already written), and the run ends with a warning, not a failure (owner, 20/11/2026 18h23).
    if (!toldInFirst) await warnOnce(api, next.number, panelLeft);
    log(`the PAINEL was not updated: ${panelLeft}`);
    return { action: "rolled", active: active.number, next: next.number, panelLeft };
  }
  return { action: "rolled", active: active.number, next: next.number };
}

/**
 * The GitHub REST client. A 5xx, or a request that got no reply within REQUEST_MS, is retried twice (after wait(5000),
 * then wait(15000)) only for calls that are safe to repeat: reads and the label calls, which set a state. A POST of an
 * issue or comment is never repeated (it may have been made): the next run finds it by the pointer, the title or the
 * marker. No PATCH is repeated here: the caller reads the body again and decides, so an old text never overwrites a new one.
 * @returns {Api}
 */
export function httpApi({ fetch: get, token, base, wait = (ms) => new Promise((ok) => setTimeout(ok, ms)) }) {
  return async function api(method, path, body) {
    const safe = method === "GET" || method === "DELETE" || path.endsWith("/labels");
    for (let attempt = 0; ; attempt += 1) {
      let reply;
      try {
        reply = await get(base + path, {
          method,
          // A request that gets no reply in 20 s is given up (and retried only where safe), never left to the job's 5 minutes.
          signal: AbortSignal.timeout(REQUEST_MS),
          headers: { authorization: "Bearer " + token, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (error) {
        if (safe && attempt < 2) { await wait(attempt ? 15000 : 5000); continue; }
        throw new Error(`${method} ${path}: no reply (${String(error)})`);
      }
      if (reply.status >= 500 && safe && attempt < 2) { await wait(attempt ? 15000 : 5000); continue; }
      if (!reply.ok) throw new Error(`${method} ${path}: HTTP ${reply.status} ${(await reply.text()).slice(0, 300)}`);
      return reply.status === 204 ? null : reply.json();
    }
  };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const base = (process.env.GITHUB_API_URL || "https://api.github.com") + "/repos/" + repo + "/";
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("missing GITHUB_TOKEN or GITHUB_REPOSITORY");
  const mode = process.env.MODE;
  if (mode !== "dry-run" && mode !== "run" && mode !== "on") throw new Error(`MODE must be dry-run, run or on; got ${JSON.stringify(mode)}`);
  // A manual run in mode run writes only once the switch is on (AGENTS.md AC (p)); a dry run needs no switch.
  if (mode === "run" && process.env.SWITCH !== "on") throw new Error("mode run needs the repository variable COORDINATION_ROLLOVER set to on; run a dry run instead");
  const event = process.env.EVENT_ISSUE ? { issue: process.env.EVENT_ISSUE, labeled: process.env.EVENT_LABELED, pullRequest: process.env.EVENT_IS_PR,
    count: process.env.EVENT_COMMENTS, atRoll: process.env.EVENT_AT_ROLL } : null;
  const result = await rollover({ api: httpApi({ fetch, token, base }), now: new Date(), dryRun: mode === "dry-run", event });
  // A PAINEL left as it is marks the run with a warning, visible in GitHub, and never fails it.
  if (result.panelLeft) console.log(warningLine(result.panelLeft));
}

/** A GitHub Actions warning annotation, on one line. */
export const warningLine = (problem) => "::warning title=PAINEL not updated::" + String(problem).replace(/[\r\n%]/g, " ");

if (process.argv[1]?.endsWith("coordination_rollover.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
