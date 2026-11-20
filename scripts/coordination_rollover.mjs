// The agents' coordination channel rolls over before GitHub closes it (owner, 20/11/2026, about 03h Fortaleza).
//
// GitHub refuses comments on an issue past 2,500. The open issue labeled canal-ativo is the channel; when it reaches
// ROLL_AT comments this opens the next part (or uses one an agent already opened by hand with the same title), writes
// the first comment there explaining the change and the label rule, puts one pointer line at the top of the previous
// part's body, changes the PAINEL's first line and moves the label LAST, so a failure at any earlier step leaves the
// channel where it was and the next comment's run finishes the same rollover. Every step is idempotent.
//
// It never closes or locks an issue and never deletes, edits or hides a comment, with one exception the owner asked for:
// the PAINEL's first line ("CANAL ATIVO: #N ..."), and only that line. A comment's text never reaches this script.
// Run by .github/workflows/coordination-rollover.yml; held by tests/coordination-rollover.test.ts.

/** @typedef {(method: string, path: string, body?: unknown) => Promise<any>} Api */

export const LABEL = "canal-ativo";
/** GitHub's limit: no comment is accepted on an issue past this. */
export const COMMENT_LIMIT = 2500;
/** 250 comments of room: at about 100 comments an hour, two hours and a half before the limit. */
export const ROLL_AT = 2250;
/** The PAINEL DA FILA, comment 6929670678 on #4827; its first line names the active part. */
export const PANEL_COMMENT_ID = 6929670678;
const FIND = "gh issue list --label canal-ativo --state open";
const MARKER = "<!-- coordination-rollover: first comment -->";
const PANEL_LINE = /^(\*\*CANAL ATIVO: )#\d+ \(parte \d+\), desde [^)]*\)/;

/** The part number in "Agent coordination — part 7 (continues #4858)", or null. */
export function partOf(title) {
  const m = /^Agent coordination — part (\d+)(?: \(continues #\d+\))?$/.exec(String(title ?? ""));
  return m ? Number(m[1]) : null;
}

export const nextTitle = (part, previous) => `Agent coordination — part ${part + 1} (continues #${previous})`;

export const pointerLine = (next) =>
  `**Canal ativo: #${next}** (this part no longer takes coordination; find the current part with \`${FIND}\`).`;

/** The body with the pointer line on top; an older pointer line of this script is replaced, nothing else changes. */
export function withPointer(body, next) {
  const text = body ?? "";
  const line = pointerLine(next);
  if (text.startsWith("**Canal ativo: #")) {
    const end = text.indexOf("\n");
    return line + (end < 0 ? "" : text.slice(end));
  }
  return text ? line + "\n\n" + text : line;
}

/** "DD/MM/YYYY HHhMM" in Fortaleza, UTC−3 with no daylight saving time. */
export function fortaleza(date) {
  const d = new Date(date.getTime() - 3 * 3600 * 1000);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${two(d.getUTCHours())}h${two(d.getUTCMinutes())}`;
}

/** The PAINEL with only its first line naming the new part; anything else in it is left as it is. */
export function panelWith(body, next, part, now) {
  const text = String(body ?? "");
  const end = text.indexOf("\n");
  const first = end < 0 ? text : text.slice(0, end);
  if (!PANEL_LINE.test(first)) throw new Error("the PAINEL's first line is not the CANAL ATIVO line; not guessing where to write");
  if (first.startsWith(`**CANAL ATIVO: #${next} (parte ${part}),`)) return text;
  return first.replace(PANEL_LINE, `$1#${next} (parte ${part}), desde ${fortaleza(now)} (Fortaleza)`) + (end < 0 ? "" : text.slice(end));
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

function firstComment(active, next) {
  return [
    MARKER,
    `**The coordination channel moved: #${active.number} is nearly full; the active channel is #${next}.**`,
    `Before you write in the channel, check which issue has the label \`${LABEL}\`: \`${FIND}\`. The label is on one issue only, and this ` +
      `workflow moves it before each part fills, with a pointer line on top of the previous part and the PAINEL's first line updated.`,
  ].join("\n\n");
}

function list(value, what) {
  if (!Array.isArray(value)) throw new Error(`unreadable ${what}: ${JSON.stringify(value)?.slice(0, 300)}`);
  return value;
}

/** One rollover check; returns { action: "none" } or { action: "rolled", next }. Throws on anything it cannot read. */
export async function rollover({ api, now, log = console.log }) {
  const labeled = list(await api("GET", `issues?labels=${LABEL}&state=all&per_page=100`), "labeled issue listing")
    .filter((i) => !i?.pull_request);
  if (labeled.length !== 1) throw new Error(`exactly one issue must have the label ${LABEL}; found ${labeled.length}: ${labeled.map((i) => "#" + i?.number).join(", ")}`);
  const active = labeled[0];
  const part = partOf(active.title);
  if (!Number.isSafeInteger(active.number) || active.state !== "open" || part === null || !Number.isSafeInteger(active.comments)) {
    throw new Error(`the labeled issue is not an open coordination part: ${JSON.stringify({ number: active.number, state: active.state, title: active.title })}`);
  }
  if (active.comments < ROLL_AT) {
    log(`#${active.number} (part ${part}) has ${active.comments} comments, below ${ROLL_AT}: nothing to do`);
    return { action: "none", active: active.number };
  }

  const title = nextTitle(part, active.number);
  const found = list(await api("GET", "issues?state=open&sort=created&direction=desc&per_page=100"), "recent issue listing")
    .filter((i) => !i?.pull_request && i?.title === title);
  if (found.length > 1) throw new Error(`more than one open "${title}": ${found.map((i) => "#" + i.number).join(", ")}`);
  const next = found[0] ?? await api("POST", "issues", { title, body: newPartBody(active, active.comments, now) });
  if (!Number.isSafeInteger(next?.number)) throw new Error("the next part has no number: " + JSON.stringify(next)?.slice(0, 300));
  log(found[0] ? `using #${next.number}, already open` : `opened #${next.number}`);

  const comments = list(await api("GET", `issues/${next.number}/comments?per_page=100`), "next part's comments");
  if (!comments.some((c) => String(c?.body ?? "").startsWith(MARKER))) {
    await api("POST", `issues/${next.number}/comments`, { body: firstComment(active, next.number) });
  }

  const pointed = withPointer(active.body, next.number);
  if (pointed !== active.body) await api("PATCH", `issues/${active.number}`, { body: pointed });

  const panel = await api("GET", `issues/comments/${PANEL_COMMENT_ID}`);
  if (typeof panel?.body !== "string") throw new Error("unreadable PAINEL comment " + PANEL_COMMENT_ID);
  const newPanel = panelWith(panel.body, next.number, part + 1, now);
  if (newPanel !== panel.body) await api("PATCH", `issues/comments/${PANEL_COMMENT_ID}`, { body: newPanel });

  // The switch itself, last: never two issues with the label, and back on the old one if the new one refuses it.
  await api("DELETE", `issues/${active.number}/labels/${LABEL}`);
  try {
    await api("POST", `issues/${next.number}/labels`, { labels: [LABEL] });
  } catch (error) {
    await api("POST", `issues/${active.number}/labels`, { labels: [LABEL] });
    throw new Error(`the label could not go on #${next.number} and is back on #${active.number}: ${String(error)}`);
  }
  log(`the channel is now #${next.number} (part ${part + 1})`);
  return { action: "rolled", active: active.number, next: next.number };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const base = (process.env.GITHUB_API_URL || "https://api.github.com") + "/repos/" + repo + "/";
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("missing GITHUB_TOKEN or GITHUB_REPOSITORY");

  /** @type {Api} */
  async function api(method, path, body) {
    const reply = await fetch(base + path, {
      method,
      headers: { authorization: "Bearer " + token, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!reply.ok) throw new Error(`${method} ${path}: HTTP ${reply.status} ${(await reply.text()).slice(0, 300)}`);
    return reply.status === 204 ? null : reply.json();
  }

  await rollover({ api, now: new Date() });
}

if (process.argv[1]?.endsWith("coordination_rollover.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
