/** A confirmed record must still name an actual online room. */
import { roomsFor } from "@/lib/call-rooms";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

async function main() {
  const original = redis.pipeline.bind(redis);
  const originalFetch = globalThis.fetch;
  let external = 0;
  globalThis.fetch = async () => { external++; throw Error("No external transport in this reproduction"); };
  const setup = { kind: "weekly", room: "https://example.com/original", video: false, meet: null, seats: 1 } as CallSetup;
  const ask = { product: "call", session: "cs_test_123456789012345678901234", start: 1_800_000_000_000, end: 1_800_003_600_000, setup };
  let link = "https://meet.google.com/abc-defg-hij", gone = false, writes = 0;
  redis.pipeline = async commands => {
    writes += commands.filter(command => command[0] === "SET").length;
    return [null, null, JSON.stringify({ provider: "google", scope: `c:calls-proof:b:${ask.session}`, link, gone }), null] as never;
  };
  try {
    is("a confirmed actual meeting link is retained", await roomsFor("calls-proof", [ask]), [link]);
    for (link of ["not a meeting URL", "javascript:alert(1)"]) {
      let refused = false;
      try { await roomsFor("calls-proof", [ask]); } catch { refused = true; }
      is("an active record with an invalid room URL is unconfirmed", refused, true);
    }
    link = "";
    is("a pending record with no assigned link retains the confirmed fallback", await roomsFor("calls-proof", [ask]), [setup.room]);
    link = "https://meet.google.com/abc-defg-hij"; gone = true;
    is("a confirmed removed meeting does not reuse its old link", await roomsFor("calls-proof", [ask]), [setup.room]);
    is("these read checks never create a room", writes, 0);
    is("these read checks never contact a provider", external, 0);
  } finally { redis.pipeline = original; globalThis.fetch = originalFetch; }
  done();
}
void main();
