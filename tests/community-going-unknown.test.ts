/**
 * lib/community-events.ts rsvpNumbers read each event's HLEN with `Number(x) || 0`: a reply in any other shape (no
 * reply, an error object, a text, a negative number) showed buyers "0 going" and, on an event with places, every
 * place left (rule 24; Claude 4 nuvem AH's sweep of the community's reads). Now the count is HLEN's own or null, and
 * the pages say no number for it, never 0, and never take the event as full for it (the RSVP itself checks the places).
 * Synthetic Redis only.
 */
import { rsvpNumbers, type CommunityEvent } from "@/lib/community-events";
import { placesWords } from "@/components/community-events";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const event = { id: "ev0001", cap: 10 } as unknown as CommunityEvent;
const store = { language: "en" } as const;

async function main(): Promise<void> {
  const real = redis.pipeline.bind(redis);
  part("a count in any other shape is unknown, never 0");
  for (const [label, reply] of [
    ["no reply", []],
    ["an error object", [{ error: "ERR synthetic" }, 0]],
    ["a text", ["3", 0]],
    ["a negative number", [-1, 0]],
    ["a fraction", [1.5, 0]],
  ] as const) {
    redis.pipeline = (async () => reply) as never;
    const read = await rsvpNumbers("community-x", [event], "member-1");
    is(`${label}: unknown`, read.get(event.id)?.going, null);
  }
  redis.pipeline = real as never;

  part("control: HLEN's own count");
  redis.pipeline = (async () => [4, 1]) as never;
  is("four coming read as four, and the member as coming", await rsvpNumbers("community-x", [event], "member-1").then((m) => m.get(event.id)), { going: 4, mine: true });
  redis.pipeline = (async () => [0, 0]) as never;
  is("none coming read as none", (await rsvpNumbers("community-x", [event], "member-1")).get(event.id)?.going, 0);
  redis.pipeline = real as never;

  part("the page says no number for a count not read");
  is("no count, no places left", placesWords(store, event, null), "");
  is("control: a count read is said", placesWords(store, event, 4), "4 going · 6 of 10 places left");
  is("control: a full event says full", placesWords(store, event, 10).endsWith("full"), true);
  done();
}

void main();
