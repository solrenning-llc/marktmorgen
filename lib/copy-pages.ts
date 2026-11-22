/**
 * A person's data copy (lib/person-copy.ts) in pages (issue #5125; the coordinator's decision, mail f6a9 and 7cdf,
 * 22 November 2026). A copier that could read without a bound reads at most COPY_PAGE_MAX_COMMANDS commands for one
 * request, and hands back where it stopped; the copy then carries a cursor the person sends on the next request, and
 * says there is more, until every page has been read. Never an incomplete copy, never a silent gap: the pages together
 * hold what one whole read finds.
 *
 * - ReadBudget: the commands one request may still send; a paged copier takes from it before each pipeline and
 *   stops, with a resume position, when the next pipeline would not fit.
 * - Resume positions are each copier's own (a sequence number, a Redis SCAN cursor), so an item kept for the whole
 *   copy is read once on some page whatever is added or deleted between the requests.
 * - The cursor the person carries is sealed with an HMAC under the deployment's key over the store, the address, the
 *   module and the position: a cursor for another person, another store or another module, or changed by hand, opens
 *   as nothing, and the copy starts again from the first page. With no key (unknown), no cursor is ever issued or
 *   opened, and a copier that has more refuses rather than read without its bound.
 *
 * Nothing here reads Redis.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveKey } from "@/lib/secret-box";

/**
 * The most commands one request of a copy may send for its paged parts. Its price, the number of pages the largest
 * community takes and the rate of copy requests are row (3) of issue #5125 (tests/plan-cost-registry.ts).
 */
export const COPY_PAGE_MAX_COMMANDS = 20_000;

/** What one request may still send. */
export class ReadBudget {
  left: number;
  constructor(commands: number) {
    if (!Number.isSafeInteger(commands) || commands < 0) throw new Error("a read budget is a whole number of commands");
    this.left = commands;
  }
  /** Whether `commands` more fit; taken only when they do. */
  take(commands: number): boolean {
    if (!Number.isSafeInteger(commands) || commands < 0) throw new Error("a read takes a whole number of commands");
    if (commands > this.left) return false;
    this.left -= commands;
    return true;
  }
  /** Gives back what was taken for a read that turned out smaller. */
  give(commands: number): void {
    if (!Number.isSafeInteger(commands) || commands < 0) throw new Error("a read gives back a whole number of commands");
    this.left += commands;
  }
}

/** One page of a paged copier: what it read, and where to go on (absent once everything was read). */
export type Page<T> = { records: T; resume?: string };

const CURSOR_LABEL = "marktmorgen/person-copy/page-cursor/v1";
const VERSION = 1;
/** A resume position is short text: a few numbers or a SCAN cursor. */
const RESUME = /^[A-Za-z0-9:._-]{1,200}$/;

const cursorKey = () => deriveKey(CURSOR_LABEL);

function mac(key: Buffer, scope: CursorScope, body: string): Buffer {
  return createHmac("sha256", key).update(`${scope.sid}\n${scope.email}\n${body}`).digest();
}

/** Whose copy a cursor belongs to. */
export type CursorScope = { sid: string; email: string };

/** The cursor for the next request, sealed to this store and address; null with no deployment key. */
export function sealCursor(scope: CursorScope, module: string, page: number, resume: string): string | null {
  const key = cursorKey();
  if (!key || !RESUME.test(resume) || !Number.isSafeInteger(page) || page < 2) return null;
  const body = Buffer.from(JSON.stringify({ v: VERSION, m: module, p: page, r: resume })).toString("base64url");
  return `${body}.${mac(key, scope, body).toString("base64url")}`;
}

/** The module, page number and position a cursor holds, only when it was sealed for this store and address. */
export function openCursor(scope: CursorScope, cursor: unknown): { module: string; page: number; resume: string } | null {
  const key = cursorKey();
  if (!key || typeof cursor !== "string" || cursor.length > 600) return null;
  const [body, seal, extra] = cursor.split(".");
  if (!body || !seal || extra !== undefined) return null;
  const want = mac(key, scope, body);
  const got = Buffer.from(seal, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const v = value as { v?: unknown; m?: unknown; p?: unknown; r?: unknown };
  if (!v || typeof v !== "object" || v.v !== VERSION || typeof v.m !== "string" || typeof v.r !== "string" || !RESUME.test(v.r)) return null;
  if (typeof v.p !== "number" || !Number.isSafeInteger(v.p) || v.p < 2) return null;
  return { module: v.m, page: v.p, resume: v.r };
}
