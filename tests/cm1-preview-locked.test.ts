/**
 * 542 [CM1], the studio's "Which spaces a member sees" preview (6 November
 * 2026): a space kept for some products and shown "Visible and locked" must
 * look in the preview exactly as it looks to a member without one of them on
 * the real community page. Drawn on a synthetic store, with the stand-in
 * Redis and a stubbed Stripe:
 *
 *   - the preview's locked list, for the products the creator checks, is the
 *     same markup the real page draws for a member holding just those, word
 *     for word: name, one line, "Locked", "Unlock with <product>" and its link,
 *     or "Access isn't available yet" (only its headings sit deeper, under the
 *     preview's own);
 *   - a space the checked products open, or one left "Hidden", is not in it;
 *   - nothing from inside a space (posts, members, its address) is in it;
 *   - the way in is worked out once, by the function the real page uses
 *     (unlocksOf), paid for in studio requests before it reads, and the
 *     preview only filters it by the same rule (lockedOf): no copy of either.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import CommunityPage from "@/app/[handle]/community/page";
import * as locked from "@/lib/community-locked";
import * as gate from "@/lib/community-gate";
import * as preview from "@/components/community-member-preview";
import { normaliseEmail } from "@/lib/auth";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setCommunity, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { CREATOR, type CommunityConfig, createPost, freshConfig, newItemId, saveConfig } from "@/lib/community";
import { leadsKey } from "@/lib/contacts";
import { mintPass, passCookieName } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "cm1p-owner@example.com";
const OUTSIDER = "cm1p-outsider@example.com";
const INSIDER = "cm1p-insider@example.com";

async function made(title: string, price: string): Promise<string> {
  const added = await addProduct(OWNER, title, "", price, null);
  if (!added.ok) throw new Error(`no product ${title}`);
  await setProductLink(OWNER, added.product.id, `https://example.com/${added.product.id}`);
  return added.product.id;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_cm1p_locked_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_cm1p_locked_only_a_stand_in";
  await claimHandle(OWNER, "lockedpeek", "Locked Peek", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLockedP001", true);
  await setSubscription(OWNER, { customerId: "cus_LockedP0001", subscriptionId: "sub_LockedP0001", active: true, period: paidPeriod() });
  const starter = await made("Starter notes", "0");
  const guide = await made("Guide", "19");
  const draft = await made("Draft plan", "9");
  await setProductHidden(OWNER, draft, true);
  const bonus = await made("Bonus", "0");
  await setCommunity(OWNER, true);
  let store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;

  const general = newItemId(), inner = newItemId(), secret = newItemId(), later = newItemId();
  const config: CommunityConfig = {
    ...freshConfig(store.name),
    access: [starter, guide, draft, bonus],
    spaces: [
      { id: general, name: "General", about: "", creatorOnly: false, only: [], level: 0 },
      { id: inner, name: "Inner circle", about: "Weekly calls for Guide buyers", creatorOnly: false, only: [guide, bonus], level: 0, shown: true },
      { id: secret, name: "Secret room", about: "A line nobody outside should read", creatorOnly: false, only: [guide], level: 0 },
      { id: later, name: "Draft room", about: "Opens with the plan", creatorOnly: false, only: [draft], level: 0, shown: true },
    ] as CommunityConfig["spaces"],
  };
  await saveConfig(id, config);
  const lead = (ids: string[]) => JSON.stringify({ agreed: false, agreedAt: "", firstAt: "", lastAt: "", titles: [], ids, source: "free", unsub: false, unsubAt: "" });
  await redis.pipeline([
    ["HSET", leadsKey(store.listId!), normaliseEmail(OUTSIDER), lead([starter])],
    ["HSET", leadsKey(store.listId!), normaliseEmail(INSIDER), lead([starter, bonus])],
  ]);
  await createPost(id, { space: inner, author: CREATOR, title: "Inside news", text: "PRIVATE-INNER-TEXT", img: null, kind: "post", poll: null }, store);

  async function draw(as: string): Promise<string> {
    cookieValues.clear();
    store = (await storeForEmail(OWNER))!;
    cookieValues.set(passCookieName(store), await mintPass(store, as, "all"));
    const page = await CommunityPage({ params: Promise.resolve({ handle: "@lockedpeek" }), searchParams: Promise.resolve({}) });
    return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {}, replace() {}, prefetch() {} } as never }, page));
  }
  const lockedPart = (html: string) => html.match(/<section[^>]*id="cm-locked"[\s\S]*?<\/section>/)?.[0] ?? "";
  // The preview's headings sit two levels deeper, under its own (h4 and h5 for the page's h2 and h3); nothing else may differ.
  const asOnPage = (html: string) => html.replace(/<(\/?)h4\b/g, "<$1h2").replace(/<(\/?)h5\b/g, "<$1h3");

  part("The way in is worked out by the real page's function, paid for before it reads");
  const unlocksOf = (locked as Record<string, unknown>).unlocksOf as undefined | ((s: typeof store, c: CommunityConfig, take: (units: number) => Promise<boolean>) => Promise<Record<string, gate.Unlock> | null>);
  is("lib/community-locked.ts has unlocksOf", typeof unlocksOf, "function");
  const LockedPreview = (preview as Record<string, unknown>).LockedPreview as undefined | ((props: Record<string, unknown>) => React.ReactElement | null);
  is("components/community-member-preview.tsx has LockedPreview", typeof LockedPreview, "function");
  const previewLocked = (gate as Record<string, unknown>).previewLocked;
  is("lib/community-gate.ts has previewLocked", typeof previewLocked, "function");
  if (!unlocksOf || !LockedPreview) return done();
  let taken = 0;
  const unlocks = await unlocksOf(store, config, async (units) => {
    taken += units;
    return true;
  });
  is("requests are taken before reading", taken > 0, true);
  is("refused: nothing is read and the answer is null", await unlocksOf(store, config, async () => false), null);

  const drawPreview = (chosen: string[], ways = unlocks) =>
    renderToStaticMarkup(
      createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {}, replace() {}, prefetch() {} } as never },
        createElement(LockedPreview, { spaces: config.spaces, access: config.access, chosen, unlocks: ways, language: store.language, look: store.look })),
    );

  part("A member with only the free starter: the preview is the real page's locked list, word for word");
  const real = lockedPart(await draw(OUTSIDER));
  is("the real page shows it (control)", [real.includes("Inner circle"), real.includes("Unlock with Guide"), real.includes("Draft room")], [true, true, true]);
  const shown = drawPreview([starter]);
  is("the same markup in the preview, its headings one step under the preview's", asOnPage(lockedPart(shown)), real);
  is("headings h4 and h5 in the studio, under its h3", [/<h4[ >]/.test(lockedPart(shown)), /<h5[ >]/.test(lockedPart(shown)), /<h[23][ >]/.test(lockedPart(shown))], [true, true, false]);
  is("drawn in the store's language and look", [shown.includes(`lang="`), shown.includes("st-page")], [true, true]);
  is("a space left Hidden is not in it", [shown.includes("Secret room"), shown.includes("A line nobody outside should read")], [false, false]);
  is("nothing from inside a space, nor its address", [shown.includes("PRIVATE-INNER-TEXT"), shown.includes("Inside news"), shown.includes(inner), shown.includes(later)], [false, false, false, false]);

  part("A member who also has Bonus: the space it opens leaves the locked list, as on the real page");
  const realInsider = lockedPart(await draw(INSIDER));
  const shownInsider = drawPreview([starter, bonus]);
  is("the same markup as the real page", asOnPage(lockedPart(shownInsider)), realInsider);
  is("Inner circle is no longer locked; Draft room still is", [lockedPart(shownInsider).includes("Inner circle"), lockedPart(shownInsider).includes("Draft room")], [false, true]);

  part("Nothing checked is not a member: no locked list is drawn");
  is("no locked list", lockedPart(drawPreview([])), "");

  part("The way in not read (studio requests used up): the member's own words for it");
  const unknown = lockedPart(drawPreview([starter], null));
  is("each locked space says it could not load the way in, with no link", [unknown.includes("Inner circle"), unknown.includes("We couldn&#x27;t load how to get in."), unknown.includes("href=")], [true, true, false]);

  part("One rule and one function, wired into the studio");
  const source = (file: string) => readFileSync(file, "utf8").replace(/\s+/g, " ");
  const studioPage = source("app/studio/community/page.tsx");
  is("the studio page asks unlocksOf, paying in studio requests", [studioPage.includes("unlocksOf(store, config, "), studioPage.includes("countStudio(")], [true, true]);
  const lockedLib = source("lib/community-locked.ts");
  is("the real page's list and the preview share lockedOf and unlocksOf", [lockedLib.includes("lockedOf(config, opened)"), lockedLib.includes("await unlocksOf(store, config, take)")], [true, true]);
  const memberPreview = source("components/community-member-preview.tsx");
  is("the preview draws the real page's LockedSpaces from previewLocked", [memberPreview.includes("<LockedSpaces"), memberPreview.includes("previewLocked(")], [true, true]);
  is("MemberPreview draws LockedPreview", memberPreview.includes("<LockedPreview"), true);
  done();
}

void main();
