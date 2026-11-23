/**
 * A removal that landed is said as removed, even when another saved entry cannot be read (board #5285, row #3069,
 * Claude 2's LEVE). removeSpend deleted the line and confirmed it gone, then read the list back; a different saved
 * entry that could not be read made that read throw, and the route answered 503 "unread". The studio then said
 * "That did not save", although the line WAS removed. Now the answer is ok with how many entries could not be read,
 * and the editor says "Removed." and points to its note about them.
 *
 * Synthetic store and lines; the real route and MemoryRedis.
 */
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/spend/route";
import { addSpend } from "@/lib/ad-spend";
import * as editor from "@/components/ad-spend-editor";
import { spendStore } from "./ad-spend-remove-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const statsId = spendStore.statsId as string;
const KEY = `nl:stats:${statsId}:spend`;
const now = Date.UTC(2026, 10, 13, 12);
const day = "2026-11-12";

async function seed(): Promise<[string, string]> {
  redis.clear();
  const a = await addSpend(statsId, { channel: "instagram", campaign: "spring", cents: 2500, from: day, to: day }, now);
  const b = await addSpend(statsId, { channel: "google", campaign: "fall", cents: 1200, from: day, to: day }, now);
  if (!a.ok || !b.ok) throw new Error("seeding the spend failed");
  const ids = b.spends.map((s) => s.id);
  return [ids[0], ids[1]];
}

async function kept(): Promise<string[]> {
  const [all] = (await redis.pipeline([["HGETALL", KEY]])) as unknown[];
  const raw = Array.isArray(all) ? all : [];
  return raw.filter((_, i) => i % 2 === 0).map(String).sort();
}

async function remove(id: string) {
  const request = new Request("https://marktmorgen.com/api/store/spend", { method: "POST", body: JSON.stringify({ action: "remove", id }) });
  const response = await POST(request as unknown as NextRequest);
  const json = (await response.json()) as { ok: boolean; error?: string; spends?: unknown[]; unreadable?: number };
  return { response, json };
}

async function main() {
  part("a removal that lands while another saved entry cannot be read says removed");
  {
    const [gone, stays] = await seed();
    // A saved entry in a shape this code does not read: its amount is unknown.
    await redis.pipeline([["HSET", KEY, "deadbeef", "not an entry"]]);
    const { response, json } = await remove(gone);
    is("the line is gone", (await kept()).includes(gone), false);
    is("the other readable line stays", (await kept()).includes(stays), true);
    is("the entry that cannot be read stays", (await kept()).includes("deadbeef"), true);
    is("the answer is ok", json.ok, true);
    is("the status is 200", response.status, 200);
    is("the answer says how many entries could not be read", json.unreadable, 1);
    is("no error is answered", json.error, undefined);
    const words = (editor as Record<string, unknown>).removedWithUnreadable;
    is("the editor has words for it", typeof words, "function");
    if (typeof words === "function") {
      const one = String(words(1));
      const two = String(words(2));
      is("one: it says removed", one.startsWith("Removed."), true);
      is("one: it never says nothing saved", /did not save/i.test(one), false);
      is("one: the words", one, "Removed. 1 other saved entry could not be read. See the note in this section.");
      is("two: the words", two, "Removed. 2 other saved entries could not be read. See the note in this section.");
    }
  }

  part("control: a removal with every entry readable answers the list after, as before");
  {
    const [gone, stays] = await seed();
    const { response, json } = await remove(gone);
    is("the answer is ok", json.ok, true);
    is("the status is 200", response.status, 200);
    is("the list after holds the other line", json.spends?.length, 1);
    is("no count of unreadable entries", json.unreadable, undefined);
    is("only the other line is kept", await kept(), [stays]);
  }

  done();
}

void main();
