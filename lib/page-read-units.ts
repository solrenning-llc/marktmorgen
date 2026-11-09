/**
 * What a studio read of a product's page, or of its earlier versions, takes of
 * the studio's requests beyond its own (Claude 5's proof on main 0ade0faf;
 * Claude 6's release of 7 November 2026): a page is kept at up to
 * MAX_STORED_PAGE_BYTES bytes and five versions of it besides, while one
 * studio request prices fifty kilobytes through the database
 * (UNIT_COST.studio). What it moves through the database and sends on to the
 * browser, past the request's own fifty kilobytes each, takes one more a
 * megabyte (lib/segments.ts, ledgerUnits; lib/sent-bytes.ts, sentUnits), taken
 * before each move: what is read is measured before it is read, and the answer
 * before it is sent. Requests not left, or not counted, refuse with
 * "studio_used" before anything more is read or sent.
 */
import type { Store } from "@/lib/store";
import { ledgerUnits } from "@/lib/segments";
import { sentUnits } from "@/lib/sent-bytes";
import { NOT_COUNTED, countUnits } from "@/lib/person-agenda-read";

/** Studio requests that reading `db` bytes of pages and sending `sent` bytes of them take beyond the request's own. Pure. */
export const pageReadUnits = (db: number, sent: number): number => ledgerUnits(db) + sentUnits(sent);

const NO_STORE = { "Cache-Control": "private, no-store" };

/** One studio read's meter: everything moved so far and the answer sent, taken before each move. */
export class PageReadMeter {
  private db = 0;
  private sent = 0;
  private taken = 0;

  constructor(private readonly store: Store) {}

  /** Before `db` more bytes are read (and an answer of `sent` bytes is sent): null once taken, else the refusal to answer with. */
  async take(db: number, sent = 0): Promise<Response | null> {
    this.db += Math.max(0, db);
    this.sent = Math.max(this.sent, sent);
    const due = pageReadUnits(this.db, this.sent) - this.taken;
    if (due <= 0) return null;
    const counted = await countUnits(this.store, due).catch(() => null);
    if (!counted || !counted.ok) {
      return Response.json({ ok: false, error: "studio_used", message: (counted && !counted.ok && counted.message) || NOT_COUNTED }, { status: 429, headers: NO_STORE });
    }
    this.taken += due;
    return null;
  }

  /** The answer, sent once what sending it takes is taken. */
  async send(body: unknown): Promise<Response> {
    const json = JSON.stringify(body);
    const refused = await this.take(0, new TextEncoder().encode(json).length);
    return refused ?? new Response(json, { headers: { "content-type": "application/json", ...NO_STORE } });
  }
}
