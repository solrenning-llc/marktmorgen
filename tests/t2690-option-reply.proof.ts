/** Independent synthetic evidence through the real option route and writers. */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addOption, addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { inviteMembers } from "@/lib/move-members";
import { POST } from "@/app/api/store/option/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "t2690-proof@example.test";
const ORIGIN = "https://marktmorgen.com";
let stripe = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (String(input).includes("stripe.com")) stripe++;
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const claimed = await claimHandle(OWNER, "toptionproof", "Synthetic options", "");
  if (!claimed.ok) throw Error("fixture store");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_T2690", true);
  const made = await addProduct(OWNER, "Synthetic club", "", "10", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw Error("fixture product");
  const id = made.product.id;
  await addOption(OWNER, id, "Basic", "10");
  await addOption(OWNER, id, "Plus", "20");
  const shop = (await storeForEmail(OWNER))!;
  const [basic, plus] = (await readProduct(shop, id))!.options.map(option => option.id);
  for (const option of [basic, plus]) await setProductLink(OWNER, option, "https://example.test/access");
  const session = await openSession(OWNER);
  const post = async (body: unknown) => {
    const response = await POST(new NextRequest(ORIGIN + "/api/store/option", { method: "POST", headers: { "content-type": "application/json", cookie: SESSION_COOKIE + "=" + session }, body: JSON.stringify(body) }));
    return [response.status, await response.json()] as const;
  };
  const renews = Math.floor(Date.now() / 1000) + 20 * 86_400;
  await inviteMembers(shop, "job_t2690", [
    { email: "one@example.test", productId: id, option: basic, renews },
    { email: "two@example.test", productId: id, option: basic, renews },
    { email: "three@example.test", productId: id, option: plus, renews },
  ]);
  const pipe = redis.pipeline.bind(redis);
  const invited = async () => (await post({ action: "invited", id }))[1].invited;
  part("An exact HLEN does not make a shorter HVALS complete");
  is("real hash has three invitations", redis.run(["HLEN", "nl:mv:" + shop.statsId]), 3);
  is("complete control", await invited(), { [basic]: 2, [plus]: 1 });
  for (const take of [0, 1]) {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const reply = await pipe(commands);
      return commands[0]?.[0] === "HVALS" ? [(reply[0] as unknown[]).slice(0, take)] : reply;
    }) as typeof redis.pipeline;
    try {
      is(`HVALS prefix ${take} is unknown for both options`, await invited(), { [basic]: null, [plus]: null });
    } finally { redis.pipeline = pipe; }
  }
  is("full reply remains complete after transport recovers", await invited(), { [basic]: 2, [plus]: 1 });

  part("Correct pipeline length with invalid SET acknowledgements is not success");
  let intercepted = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length > 1 && commands.every(command => ["SET", "HSET", "DEL"].includes(String(command[0]))) && commands.some(command => String(command[1]).includes(id) || String(command[1]).includes(plus))) {
      intercepted++;
      return commands.map(() => null); // The write was not applied, and SET did not confirm it.
    }
    return pipe(commands);
  }) as typeof redis.pipeline;
  let result;
  try { result = await post({ action: "sale", id: plus, onSale: false }); }
  finally { redis.pipeline = pipe; }
  is("the intended product pipeline was intercepted", intercepted, 1);
  is("unknown SET is not reported as successful", [result[0] === 200, result[1].ok === true], [false, false]);
  is("product really stayed on sale", (await readProduct((await storeForEmail(OWNER))!, id))!.options.find(option => option.id === plus)?.offSale === true, false);
  is("no Stripe request", stripe, 0);
  done();
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
