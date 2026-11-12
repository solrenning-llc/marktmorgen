/**
 * Stopping the counting of link use never writes an older copy of the contact
 * over a change made in the same moment, and is never answered as done when
 * its write could not be confirmed (CX-123 rule 24).
 */
import { leadsKey, parseContact, tokensFor, unsubscribe, upsertContact } from "@/lib/contacts";
import { stopCounting } from "@/lib/mail-clicks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const list = "clicks-stop-race";
const email = "gus@example.com";

async function row() {
  const [raw] = await redis.pipeline([["HGET", leadsKey(list), email]]);
  return parseContact(typeof raw === "string" ? raw : null);
}

async function fresh(): Promise<string> {
  await redis.pipeline([["DEL", leadsKey(list)]]);
  await upsertContact(list, email, { agreed: true, explicit: true, clicks: true, source: "free" }, ROOM);
  return (await tokensFor(list, [email], "harbor")).get(email)!;
}

async function main() {
  const original = redis.pipeline;
  try {
    part("An unsubscribe made while the stop is on its way is kept");
    const token = await fresh();
    let raced = false;
    redis.pipeline = async (commands) => {
      // The stop's write: let the person leave the list just before it lands.
      if (!raced && commands.some((c) => (c[0] === "HSET" || c[0] === "EVAL") && c.includes(leadsKey(list)))) {
        raced = true;
        redis.pipeline = original;
        await unsubscribe(token);
      }
      return original.call(redis, commands);
    };
    let threw = false;
    try { await stopCounting(token); } catch { threw = true; }
    redis.pipeline = original;
    const after = await row();
    is("the race happened", raced, true);
    is("the person who left stays off the list", after?.unsub, true);
    is("and nothing is counted for them", Boolean(after?.clicks), false);
    is("a stop that lost the race is not an error", threw, false);

    part("An unconfirmed write is not done");
    const again = await fresh();
    redis.pipeline = async (commands) => {
      // Answered in another shape: whether it was written is not known.
      if (commands.some((c) => c[0] === "DEL" || c[0] === "HSET" || c[0] === "EVAL")) return [];
      return original.call(redis, commands);
    };
    let answered: unknown = "none";
    try { answered = await stopCounting(again); } catch { answered = "threw"; }
    redis.pipeline = original;
    is("an unknown answer throws instead of saying stopped", answered, "threw");
  } finally {
    redis.pipeline = original;
  }
  done();
}
void main();
