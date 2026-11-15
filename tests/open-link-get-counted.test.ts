/**
 * MM-SA-41 follow-up (same-family reading 51LL): every request of an emailed community or course link pays for its own
 * reads. The GET reads the link and the store, the page reads the store and draws the form, the tap spends the open:
 * each takes its own buyer reads from the store's month (lib/buyer-actions.ts, OPEN_LINK_GET_UNITS,
 * OPEN_LINK_PAGE_UNITS, OPEN_LINK_TAP_UNITS), before what it serves. Before, only the tap took the reads of the whole
 * open, so a mail filter or a script that fetched the link or its page N times, and never tapped, cost N times the
 * reads and counted none of them.
 *
 * Also the words of the page: it never says a link "is good" before the tap has read it (the count of its opens is
 * read only then), and it never asks for a "tap" only, which a keyboard or a mouse does not make.
 */
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { allowanceWindow } from "@/lib/allowance-window";
import { requestsIn } from "@/lib/traffic";
import { OPEN_LINK_GET_UNITS, OPEN_LINK_PAGE_UNITS, OPEN_LINK_REQUEST_UNITS, OPEN_LINK_TAP_UNITS } from "@/lib/buyer-actions";
import { OPEN_LINK_WORDS } from "@/lib/buyer-words/open-link";
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
const N = 3;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "open-count@example.com";
  const BUYER = "open-count-buyer@example.com";
  await claimHandle(OWNER, "opencount", "Open Count", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_OpenCount1", subscriptionId: "sub_OpenCount1", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Bread course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductCourse(OWNER, made.product.id, { id: "c".repeat(32), lessons: 1 });
  const store = (await storeForEmail(OWNER))!;
  const folder = await storeFolder(OWNER);
  const window = allowanceWindow(store)!.id;
  const counted = () => requestsIn(folder, window);

  part("The units of one whole open");
  is("each request takes at least one", [OPEN_LINK_GET_UNITS, OPEN_LINK_PAGE_UNITS, OPEN_LINK_TAP_UNITS].every((n) => Number.isInteger(n) && n >= 1), true);
  is("the whole open is the three together, never less than the two counted before", [OPEN_LINK_REQUEST_UNITS, OPEN_LINK_REQUEST_UNITS >= 2], [OPEN_LINK_GET_UNITS + OPEN_LINK_PAGE_UNITS + OPEN_LINK_TAP_UNITS, true]);

  const kinds = [
    { name: "community", get: communityGet as Handler, post: communityPost as Handler, token: "a".repeat(64), grantKey: (t: string) => `nl:cm:link:${sha(`nimbus-community:${t}`).slice(0, 40)}`, grant: { e: BUYER, k: storeKey(store), h: store.handle }, Page: CommunityOpenPage, path: "community" },
    { name: "course", get: courseGet as Handler, post: coursePost as Handler, token: "b".repeat(64), grantKey: (t: string) => `nl:learn:link:${sha(t)}`, grant: { e: BUYER, k: storeKey(store), h: store.handle, p: made.product.id }, Page: CourseOpenPage, path: "course" },
  ];
  for (const kind of kinds) {
    await redis.pipeline([["SET", kind.grantKey(kind.token), JSON.stringify(kind.grant), "EX", 3_600]]);
    const url = `${ORIGIN}/api/store/${kind.path}/open`;

    part(`${kind.name}: ${N} GETs and no tap count ${N} times their reads`);
    const beforeGets = await counted();
    for (let i = 0; i < N; i += 1) {
      const res = await kind.get(new NextRequest(`${url}?token=${kind.token}`, { headers: { Host: "marktmorgen.com" } }));
      is(`GET ${i + 1} still sends on to the page`, res.status, 303);
    }
    is(`${N} GETs counted`, (await counted()) - beforeGets, N * OPEN_LINK_GET_UNITS);

    part(`${kind.name}: ${N} views of the page and no tap count ${N} times their reads`);
    const beforePages = await counted();
    for (let i = 0; i < N; i += 1) renderToStaticMarkup(await kind.Page({ params: Promise.resolve({ handle: `@${store.handle}` }), searchParams: Promise.resolve({ token: kind.token }) }));
    is(`${N} pages counted`, (await counted()) - beforePages, N * OPEN_LINK_PAGE_UNITS);

    part(`${kind.name}: the tap takes only its own reads`);
    const beforeTap = await counted();
    const form = new FormData();
    form.set("token", kind.token);
    const tapped = await kind.post(new NextRequest(url, { method: "POST", body: form, headers: { Host: "marktmorgen.com", Origin: ORIGIN } }));
    is("the pass is given", tapped.status, 303);
    is("the tap counted its own", (await counted()) - beforeTap, OPEN_LINK_TAP_UNITS);
  }

  part("The page's words");
  for (const [code, w] of Object.entries(OPEN_LINK_WORDS)) {
    const lead = w.lead("Open Count");
    // The page has read nothing of the link's state (its count of opens is read only at the press): no word of it.
    is(`${code}: the lead never says the link's state before the press reads it`, /(is good|is ready|ready to use|válid|valide|gültig|valido|geldig|listo|prêt|bereit|pronto|pronta|klaar)/i.test(lead), false);
  }
  const en = OPEN_LINK_WORDS.en;
  is("en: no word asks for a tap only, which a keyboard or mouse does not make", /\btap\b/i.test([en.heading, en.lead("S"), en.why, en.bad].join(" ")), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
