/**
 * Two forms that send a paid email on a visitor's say-so, the store contact
 * form (lib/store-contact.ts) and the affiliate page link
 * (lib/affiliate-hub.ts), sit behind hourly and daily counters. A counter
 * that could not be read is not room: nothing is sent, and the answer is
 * "error" (the page says the message could not be sent just now, try again),
 * never "limited", which would tell somebody who did nothing that they tried
 * too often. A counter read past its limit is "limited", as before. The same
 * three answers as essentialLimitState (lib/request-guard.ts) and the
 * address-move form (app/api/store/address/route.ts, addressLimitAnswer).
 */
import { claimHandle, ensureStatsId, ensureStoreId, setContact, storeForEmail } from "@/lib/store";
import { sendContact } from "@/lib/store-contact";
import { rememberAffiliate, requestHubLink } from "@/lib/affiliate-hub";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let sends = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    sends++;
    return new Response(JSON.stringify({ id: `email_${sends}` }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

/** How a counter's pipeline answers: as Redis would, by throwing, or in another shape. */
type Mode = "real" | "throw" | "shape";
const real = redis.pipeline.bind(redis);
let broken: { scope: string; mode: Mode } = { scope: "", mode: "real" };
redis.pipeline = (async (commands: (string | number)[][]) => {
  const key = commands.find((command) => command[0] === "INCR")?.[1];
  if (typeof key === "string" && key.startsWith(`nl:rl:${broken.scope}:`)) {
    if (broken.mode === "throw") throw new Error("redis unreachable (synthetic)");
    if (broken.mode === "shape") return ["OK", "seven"];
  }
  return real(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_contact_only";
  const owner = "maker@example.com";
  if (!(await claimHandle(owner, "makershop", "Maker Shop", "")).ok) throw new Error("no store");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setContact(owner, { on: true });
  const store = (await storeForEmail(owner))!;
  let n = 0;
  const contact = (ip = `1.1.1.${++n}`) =>
    sendContact({ store, name: "Dana", email: "dana@example.com", message: `Could we work together on a cookbook? #${++n}`, ip });

  part("Contact form: a counter that could not be read sends nothing and says so");
  for (const scope of ["contact-ip", "contact-store"]) {
    for (const mode of ["throw", "shape"] as const) {
      broken = { scope, mode };
      const before = sends;
      is(`${scope} ${mode}: "error", no email`, [await contact(), sends - before], ["error", 0]);
    }
  }
  broken = { scope: "", mode: "real" };

  part("Contact form: a counter read past its limit is still \"limited\"");
  const fromOne = [await contact("2.2.2.2"), await contact("2.2.2.2"), await contact("2.2.2.2")];
  const before = sends;
  is("the fourth from one connection in an hour", [await contact("2.2.2.2"), sends - before], ["limited", 0]);
  is("the first three went", fromOne, ["sent", "sent", "sent"]);

  part("Affiliate page link: a counter that could not be read sends nothing and says so");
  const affiliate = "aff@example.com";
  await rememberAffiliate(store.sid!, affiliate);
  let m = 0;
  const hub = (ip = `3.3.3.${++m}`) => requestHubLink({ email: affiliate, ip, origin: "https://marktmorgen.com" });
  for (const scope of ["affhub-ip", "affhub-address"]) {
    for (const mode of ["throw", "shape"] as const) {
      broken = { scope, mode };
      const prior = sends;
      is(`${scope} ${mode}: "error", no email`, [await hub(), sends - prior], ["error", 0]);
    }
  }
  broken = { scope: "", mode: "real" };

  part("Affiliate page link: a counter read past its limit is still \"limited\"");
  const sentOk = await hub("4.4.4.4");
  is("an affiliate asking with every counter readable gets the link", sentOk, "sent");
  const answers: string[] = [];
  for (let k = 0; k < 10; k++) answers.push(await hub("4.4.4.4"));
  const after = sends;
  is("past five an hour for one address", [answers.filter((a) => a === "limited").length > 0, await hub("5.5.5.5"), sends - after], [true, "limited", 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
