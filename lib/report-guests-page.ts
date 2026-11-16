/**
 * The pages behind the two links of the numbers email to addresses outside
 * the team (405 [HX1], unit 4): app/api/numbers-guest/confirm and
 * app/api/numbers-guest/leave. One plain page each time, in US English: a
 * title, a sentence or two and, for a question, one button. A GET only
 * shows the question, because mail apps open links to check them; the
 * button sends the POST that does it.
 *
 * AX274: the page's language is marked; one main region with one heading;
 * text at 16.9:1 and the button at 10.6:1 (11.5:1 in dark mode); the button
 * at least 44 by 44 pixels with a 3-pixel focus ring; no time limit, nothing
 * that moves; lines under 80 characters wide, at 1.5 line height; it reflows
 * at 320 pixels and follows the browser's text size. The page says the
 * store's name and what the person gets, so no link text is needed to know
 * what the button does.
 *
 * The link's token is in the form's address only, never in the text; the
 * page is not kept by a cache or a search engine, and sends no Referer.
 */
import { FIGURE_WORDS, INVITE_DAYS, type ReportEvery, type ReportFigure } from "@/lib/report-guests-rules";
import { type LinkKind } from "@/lib/report-guests-links";
import { checkLink, answerLink } from "@/lib/report-guests";
import { clientAddress, withinLimit } from "@/lib/request-guard";
import { storeForIdExact } from "@/lib/store";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = [
  ":root{color-scheme:light dark}",
  "body{font:1rem/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#1d1b29;background:#fff}",
  "button{font:inherit;min-width:44px;min-height:44px;padding:.6rem 1.1rem;border-radius:.6rem;border:2px solid #3b2a9a;background:#3b2a9a;color:#fff;cursor:pointer}",
  "button:focus-visible{outline:3px solid #1d1b29;outline-offset:3px}",
  "@media (prefers-color-scheme:dark){body{color:#f4f2fa;background:#14121c}button{background:#cfc4ff;border-color:#cfc4ff;color:#14121c}button:focus-visible{outline-color:#f4f2fa}}",
  "@media (forced-colors:active){button{border-color:ButtonText}}",
].join("");

/**
 * A whole page: `title` is its heading too; `paragraphs` are plain text, escaped here; `list`, a list after the
 * first paragraph; `button` a form that posts to `action`.
 */
export function guestPage(title: string, paragraphs: string[], options: { status?: number; action?: string; button?: string; list?: string[] } = {}): Response {
  const list = options.list?.length ? `<ul>${options.list.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : "";
  const text = paragraphs.map((p, i) => `<p>${esc(p)}</p>${i === 0 ? list : ""}`).join("");
  const form = options.action && options.button ? `<form method="post" action="${esc(options.action)}"><button type="submit">${esc(options.button)}</button></form>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main><h1>${esc(title)}</h1>${text}${form}</main></body></html>`;
  return new Response(html, {
    status: options.status ?? 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" },
  });
}

const EVERY_WORDS: Record<ReportEvery, string> = { week: "every week", month: "every month" };

/** The figures' names, one a line, in the order they are shown. */
export function figuresSaid(figures: ReportFigure[]): string[] {
  return figures.map((figure) => FIGURE_WORDS[figure]);
}

export const pageFor = {
  confirmAsk: (name: string, every: ReportEvery, figures: ReportFigure[], action: string) =>
    guestPage(
      `Get the numbers of ${name} by email?`,
      [
        figures.length
          ? `${name} wants to email you these numbers of its store ${EVERY_WORDS[every]}:`
          : `${name} wants to email you numbers of its store ${EVERY_WORDS[every]}. It has not picked which ones yet, and nothing is sent until it does.`,
        "Nothing is sent to you until you say yes. Every email has a link to stop it.",
      ],
      { action, button: "Yes, send me these emails", list: figuresSaid(figures) },
    ),
  confirmed: (name: string, every: ReportEvery) =>
    guestPage("You will get the numbers", [`You will get the numbers of ${name} by email ${EVERY_WORDS[every]}. Every email has a link to stop it.`]),
  alreadyConfirmed: (name: string) => guestPage("You already said yes", [`You already get the numbers of ${name}. Every email has a link to stop it.`]),
  expired: (name: string) => guestPage("This invitation has ended", [`Invitations last ${INVITE_DAYS} days. Ask ${name} to invite you again.`], { status: 410 }),
  leaveAsk: (name: string, action: string) =>
    guestPage(
      `Stop the numbers emails from ${name}?`,
      [`This stops the emails with the numbers of ${name}. If ${name} invites you again later, nothing is sent until you say yes again.`],
      { action, button: "Stop these emails" },
    ),
  left: (name: string) => guestPage("Stopped", [`You will not get the numbers of ${name} anymore.`]),
  alreadyLeft: (name: string) => guestPage("Already stopped", [`You do not get the numbers of ${name} anymore.`]),
  unknown: () => guestPage("Link not recognized", ["We do not recognize this link. It may have been replaced by a newer one, or the store took your address off its list."], { status: 400 }),
  tooMany: () => guestPage("Too many tries", ["Please wait a few minutes, then try again."], { status: 429 }),
  notNow: () => guestPage("Nothing changed yet", ["We could not read this link just now, so nothing changed. Please try again in a minute."], { status: 503 }),
};

// ---- The doors themselves, shared by the two routes --------------------------

/** Presses and looks a connection may make in ten minutes, both links together. */
export const LIMIT_TRIES = 30;
const admitted = (request: Request) => withinLimit("numbers-guest", clientAddress(request), LIMIT_TRIES, 600);

function tokenOf(request: Request): string {
  return (new URL(request.url).searchParams.get("t") ?? "").slice(0, 64);
}

const actionFor = (kind: LinkKind, token: string) => `/api/numbers-guest/${kind}?t=${encodeURIComponent(token)}`;

async function storeName(sid: string): Promise<string | null> {
  const store = await storeForIdExact(sid);
  return store ? store.name || `@${store.handle}` : null;
}

/** A GET: what the link would do, as a question with one button; nothing changes. */
export async function showLink(kind: LinkKind, request: Request, now = Date.now()): Promise<Response> {
  if (!(await admitted(request))) return pageFor.tooMany();
  const token = tokenOf(request);
  try {
    const seen = await checkLink(kind, token, now);
    const name = seen.sid ? await storeName(seen.sid) : null;
    if (seen.result === "no" || !name || !seen.share) return pageFor.unknown();
    if (kind === "confirm") {
      if (seen.result === "done") return pageFor.alreadyConfirmed(name);
      if (seen.result === "expired") return pageFor.expired(name);
      return pageFor.confirmAsk(name, seen.share.every, seen.share.figures, actionFor(kind, token));
    }
    return seen.result === "done" ? pageFor.alreadyLeft(name) : pageFor.leaveAsk(name, actionFor(kind, token));
  } catch (error) {
    console.error("a numbers email link could not be read", error);
    return pageFor.notNow();
  }
}

/**
 * A POST: does it. The leave link's POST is also what a mail app sends for
 * its own unsubscribe button (RFC 8058, List-Unsubscribe-Post), so its body
 * is never needed.
 */
export async function pressLink(kind: LinkKind, request: Request, now = Date.now()): Promise<Response> {
  if (!(await admitted(request))) return pageFor.tooMany();
  const token = tokenOf(request);
  try {
    const used = await answerLink(kind, token, now);
    const name = used.sid ? await storeName(used.sid) : null;
    if (used.result === "no" || !used.share) return pageFor.unknown();
    // The change is made; a store whose record cannot name it now still gets a true answer.
    const said = name ?? "this store";
    if (used.result === "confirmed") return pageFor.confirmed(said, used.share.every);
    if (used.result === "left") return pageFor.left(said);
    if (used.result === "expired") return pageFor.expired(said);
    return kind === "confirm" ? pageFor.alreadyConfirmed(said) : pageFor.alreadyLeft(said);
  } catch (error) {
    console.error("a numbers email link could not be used", error);
    return pageFor.notNow();
  }
}
