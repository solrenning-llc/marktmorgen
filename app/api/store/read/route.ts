import type { NextRequest } from "next/server";
import { isBot } from "@/lib/source-rules";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { countDepth, depthField } from "@/lib/page-depth";
import { READ_TOKEN_MAX, STORE_SCOPE, reachField, readTokenPass, spendReadToken, takeReading } from "@/lib/page-read";
import { countReach } from "@/lib/stats";

const MAX_BODY_BYTES = 600;

const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

/**
 * How a page was read, sent by one visitor in eight as they leave it
 * (lib/page-read.ts): the furthest block of a sales page, with how long it
 * was open and the video and answer, or the furthest item of the store's
 * page and the one clicked.
 *
 * Every reading has its ceiling before it costs anything (639 [GL7](25)):
 * what is not what a page sends, a token not made for this page by this
 * deployment, older than READ_TOKEN_SECONDS or of a visitor not drawn costs
 * no command; a token used already costs the one command that says so
 * (spendReadToken); a reading past its window's ceiling costs that command
 * and the count's two (takeReading) and is not counted. The store is never
 * read and its window of public requests never touched: the token says which
 * window and ceiling the reading counts against, so readings never make a
 * store's pages rest. The answer is always empty.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return done();
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return done();
  if (isBot(request.headers.get("user-agent") ?? "")) return done();
  let body: Record<string, unknown> = {};
  try {
    const raw = await (await limited(request, MAX_BODY_BYTES)).text();
    if (raw.length > MAX_BODY_BYTES) return done();
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    return done();
  }
  const text = (name: string, max: number) => (typeof body[name] === "string" ? (body[name] as string).slice(0, max) : "");
  const token = text("t", READ_TOKEN_MAX + 1);

  // What is counted, worked out before any command: a sales page's furthest block, or the store page's field.
  let count: ((statsId: string) => Promise<void>) | null = null;
  let scope = "";
  if (body.k === "d") {
    // A sales page: the product it belongs to, the furthest block seen, the answer, the video and the seconds.
    scope = text("p", 40);
    const [block, whyNot, video] = [text("b", 12), text("w", 10), text("v", 20)];
    if (depthField(block, whyNot, video)) count = (statsId) => countDepth(statsId, scope, block, whyNot, video, body.s);
  } else if (body.k === "s") {
    // The store's own page: where the furthest item seen stood, which it was, and the one clicked.
    scope = STORE_SCOPE;
    const field = reachField(body.n, text("b", 42), text("c", 42));
    if (field) count = (statsId) => countReach(statsId, field);
  }
  const pass = count ? readTokenPass(token, scope) : null;
  if (!count || !pass) return done();
  // Once a visit: the token's nonce is marked used before anything else is asked.
  if (!(await spendReadToken(pass.nonce, pass.issued))) return done();
  // One of the window's readings, counted and checked against its ceiling in one pipeline: past it, nothing more.
  if (!(await takeReading(pass))) return done();
  await count(pass.statsId).catch(() => {});
  return done();
}
