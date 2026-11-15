/**
 * MM-SA-41 (docs/security-audit-2026-10-28.md): the emailed links that open a
 * store's community (app/api/store/community/open/route.ts) and its courses
 * (app/api/store/course/open/route.ts) are spent only by a tap on this site,
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
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setLanguage, setSubscription, storeForEmail } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { GET as communityGet, POST as communityPost } from "@/app/api/store/community/open/route";
import { GET as courseGet, POST as coursePost } from "@/app/api/store/course/open/route";
import CommunityOpenPage from "@/app/[handle]/community/open/page";
import CourseOpenPage from "@/app/[handle]/course/open/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

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
  const made = await addProduct(OWNER, "Bread course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductCourse(OWNER, made.product.id, { id: "c".repeat(32), lessons: 1 });
  const store = (await storeForEmail(OWNER))!;

  const kinds = [
    {
      name: "community",
      get: communityGet as Handler,
      post: communityPost as Handler,
      token: "a".repeat(64),
      grantKey: (token: string) => `nl:cm:link:${sha(`nimbus-community:${token}`).slice(0, 40)}`,
      grant: { e: BUYER, k: storeKey(store), h: store.handle },
      page: `/@${store.handle}/community/open?token=`,
      lands: `${ORIGIN}/@${store.handle}/community`,
      Page: CommunityOpenPage,
    },
    {
      name: "course",
      get: courseGet as Handler,
      post: coursePost as Handler,
      token: "b".repeat(64),
      grantKey: (token: string) => `nl:learn:link:${sha(token)}`,
      grant: { e: BUYER, k: storeKey(store), h: store.handle, p: made.product.id },
      page: `/@${store.handle}/course/open?token=`,
      lands: `${ORIGIN}/@${store.handle}/course/${made.product.id}`,
      Page: CourseOpenPage,
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
    const html = renderToStaticMarkup(await kind.Page({ params: Promise.resolve({ handle: store.handle }), searchParams: Promise.resolve({ token: kind.token }) }));
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
  }

  part("The page speaks the store's language");
  await setLanguage(OWNER, "es");
  const spanish = renderToStaticMarkup(await CommunityOpenPage({ params: Promise.resolve({ handle: store.handle }), searchParams: Promise.resolve({ token: "a".repeat(64) }) }));
  is("lang is the store's", spanish.includes('lang="es"'), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
