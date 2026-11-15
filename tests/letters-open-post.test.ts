/**
 * MM-SA-53 (docs/security-audit-2026-10-28.md), item letters/open: the
 * emailed link that opens a store's letter (app/api/store/letters/open/route.ts)
 * is spent only by a tap on this site, as MM-SA-41 made the community's and
 * the courses' (tests/open-link-post.test.ts),
 * as the sign-in link is (app/api/auth/callback/route.ts).
 *
 *   - A GET spends nothing and sets no pass: a mail filter or a link preview
 *     that fetches the link, however often, leaves every open of it whole.
 *     It sends the browser to the store's page that asks for one tap.
 *   - That page holds the token in a form that posts back here, in the
 *     store's language.
 *   - A POST from another site is refused before anything is read, so no
 *     other site can make a visitor's browser act as the link's owner.
 *   - A POST from this site spends one open and gives the pass, as the GET
 *     did before: the buyer keeps the access they had, for as long as before.
 */
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, setLanguage, setSubscription, storeForEmail } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { OPEN_LINK_REQUEST_UNITS } from "@/lib/buyer-actions";
import { GET as lettersGet, POST as lettersPost } from "@/app/api/store/letters/open/route";
import LettersOpenPage from "@/app/[handle]/letters/open/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { COMMANDS } from "./traffic-cost";
import { REQUEST_COMMANDS } from "./plan-cost-registry";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ORIGIN = "https://marktmorgen.com";
type Handler = (request: NextRequest) => Promise<Response>;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "open-owner@example.com";
  const BUYER = "open-buyer@example.com";
  await claimHandle(OWNER, "openshop", "Open Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_OpenShop01", subscriptionId: "sub_OpenShop01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;

  const LETTER = "0123456789abcdef0123";
  const kinds = [
    {
      name: "letters",
      get: lettersGet as Handler,
      post: lettersPost as Handler,
      token: "c".repeat(64),
      grantKey: (token: string) => `nl:letters:link:${sha(`nimbus-letter:${token}`).slice(0, 40)}`,
      grant: { e: BUYER, k: storeKey(store), h: store.handle, l: LETTER },
      page: `/@${store.handle}/letters/open?token=`,
      lands: `${ORIGIN}/@${store.handle}/letters/${LETTER}`,
      Page: LettersOpenPage,
    },
  ];

  for (const kind of kinds) {
    await redis.pipeline([["SET", kind.grantKey(kind.token), JSON.stringify(kind.grant), "EX", 3_600]]);
    const url = `${ORIGIN}/api/store/${kind.name}/open`;
    const opens = () => redis.keys().filter((key) => key.startsWith(kind.grantKey(kind.token)) && key.endsWith(":opens")).length;
    const passes = () => redis.keys().filter((key) => key.startsWith("nl:learn:pass:")).length;
    const startPasses = passes();

    part(`${kind.name}: a GET, however often, spends nothing and gives no pass`);
    for (let i = 0; i < 3; i += 1) {
      const got = await kind.get(new NextRequest(`${url}?token=${kind.token}`, { headers: { Host: "marktmorgen.com" } }));
      is(`GET ${i + 1}: to the page that asks for a tap, with no cookie`, [got.status, got.headers.get("location"), got.headers.get("set-cookie")], [303, `${ORIGIN}${kind.page}${kind.token}`, null]);
    }
    is("no open counted and no pass written", [opens(), passes() - startPasses], [0, 0]);

    part(`${kind.name}: the page holds the token in a form that posts back here`);
    const html = renderToStaticMarkup(await kind.Page({ params: Promise.resolve({ handle: `@${store.handle}` }), searchParams: Promise.resolve({ token: kind.token }) }));
    is("a form that posts to the route, with the token and one button", [
      html.includes(`action="/api/store/${kind.name}/open"`),
      html.includes('method="post"'),
      html.includes(`value="${kind.token}"`),
      (html.match(/<button/g) ?? []).length,
    ], [true, true, true, 1]);

    part(`${kind.name}: a POST from another site is refused before anything is read`);
    const post = (headers: Record<string, string>) =>
      kind.post(new NextRequest(url, { method: "POST", headers: { Host: "marktmorgen.com", "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams([["token", kind.token]]) }));
    const away = await post({ Origin: "https://elsewhere.example" });
    is("403, no cookie, nothing spent", [away.status, away.headers.get("set-cookie"), opens(), passes() - startPasses], [403, null, 0, 0]);

    part(`${kind.name}: a tap on this site spends one open and gives the pass, as before`);
    const tapped = await post({ Origin: ORIGIN });
    is("on to what the link opens, with the store's pass", [tapped.status, tapped.headers.get("location"), Boolean(tapped.headers.get("set-cookie"))], [303, kind.lands, true]);
    is("one open spent, one pass written", [opens(), passes() - startPasses], [1, 1]);

    part(`${kind.name}: a link used up is said as gone at the tap, as before`);
    await redis.pipeline([["SET", `${kind.grantKey(kind.token)}:opens`, "10", "EX", 3_600]]);
    const used = await post({ Origin: ORIGIN });
    is("410, no cookie, no pass", [used.status, used.headers.get("set-cookie"), passes() - startPasses], [410, null, 1]);
    await redis.pipeline([["DEL", `${kind.grantKey(kind.token)}:opens`]]);

    part(`${kind.name}: a whole open, the GET, the page and the tap, stays inside the buyer reads it is counted as`);
    const original = redis.pipeline.bind(redis);
    let commands = 0;
    redis.pipeline = async (batch) => { commands += batch.length; return original(batch); };
    try {
      await kind.get(new NextRequest(`${url}?token=${kind.token}`, { headers: { Host: "marktmorgen.com" } }));
      renderToStaticMarkup(await kind.Page({ params: Promise.resolve({ handle: `@${store.handle}` }), searchParams: Promise.resolve({ token: kind.token }) }));
      const whole = await post({ Origin: ORIGIN });
      is("the pass is given", whole.status, 303);
    } finally {
      redis.pipeline = original;
    }
    // A buyer read is one of the store's public requests (lib/buyer-actions.ts), priced as a later page with its count
    // (tests/traffic-cost.ts, COMMANDS.laterPage; tests/plan-cost-registry.ts, REQUEST_COMMANDS).
    is(`${commands} commands, at most the later pages it is counted as`, commands <= OPEN_LINK_REQUEST_UNITS * (COMMANDS.laterPage + REQUEST_COMMANDS), true);
  }

  part("The page speaks the store's language");
  await setLanguage(OWNER, "es");
  const spanish = renderToStaticMarkup(await LettersOpenPage({ params: Promise.resolve({ handle: `@${store.handle}` }), searchParams: Promise.resolve({ token: "c".repeat(64) }) }));
  is("lang is the store's", spanish.includes('lang="es-ES"'), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
