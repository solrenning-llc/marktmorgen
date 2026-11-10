/**
 * 486 [IT3], unit 2: "What do you want to do?" inside the studio's one search
 * box (766 [STN13]). The actions of unit 1 (lib/studio-actions.ts) become the
 * box's first group, "Things to do", found in the browser from the list the
 * server worked out for this person and this store, with no request of their
 * own: what the person's role and the store's conditions let them open, and
 * nothing else. An action the server did not offer is never shown, an id it
 * does not know is never shown, and a role it does not know is offered none.
 * A tool that opens the same screen as an action shown is not shown twice;
 * the sentence read out counts the actions with the rest.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { STUDIO_ACTIONS, score, termsOf } from "@/lib/studio-actions";
import { available, offeredFor, resultFor, searchActions } from "@/lib/studio-actions-gallery";
import { STUDIO_MODULES, type GalleryContext } from "@/lib/studio-modules";
import { PER_GROUP, type SearchAnswer, answerSentence } from "@/lib/studio-search-rules";
import { studioSearch } from "@/lib/studio-search";
import { studioPath } from "@/lib/studio-route";
import { can, type Role } from "@/lib/team-roles";
import { StudioSearch } from "@/components/studio-search";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Pure = typeof import("@/lib/studio-search-actions");
type Server = typeof import("@/lib/studio-actions-offered");

const href = (segment: string) => (segment ? `/studio/${segment}?store=s1` : "/studio?store=s1");
const PLAN_HREF = "/studio?store=s1#billing";
const everything = { discord: true, meet: true, memberships: true, calls: true, proOnSale: true };
const context = (role: Role, over: Partial<GalleryContext> = {}): GalleryContext => ({
  may: (permission) => can(role, permission),
  has: { ...everything },
  pro: true,
  planHref: PLAN_HREF,
  billing: can(role, "billing"),
  onSale: true,
  ...over,
});
const ids = (results: readonly { id: string }[]) => results.map((result) => result.id);

async function main(): Promise<void> {
  const pure = (await import("@/lib/studio-search-actions").catch(() => null)) as Pure | null;
  const server = (await import("@/lib/studio-actions-offered").catch(() => null)) as Server | null;
  is("the actions group's rules exist (lib/studio-search-actions.ts)", pure !== null, true);
  is("the server's list of actions exists (lib/studio-actions-offered.ts)", server !== null, true);
  if (!pure || !server) return done();
  const { ACTIONS_TITLE, matchActions, withActions } = pure;

  part("What the server offers: the gallery's role and conditions, as unit 1 reads them");
  for (const role of ["owner", "admin", "editor", "support"] as Role[]) {
    for (const [name, over] of [
      ["everything on", {}],
      ["no Discord, no video calls, no memberships, no calls", { has: { discord: false, meet: false, memberships: false, calls: false, proOnSale: true } }],
      ["not on the Studio plan, plan page drawn", { pro: false }],
      ["not on the Studio plan, no plan page", { pro: false, planHref: null }],
    ] as [string, Partial<GalleryContext>][]) {
      const ctx = context(role, over);
      const offered = offeredFor(ctx, href);
      const want = STUDIO_ACTIONS.filter((action) => available(action, ctx) && resultFor(action, ctx, href) !== null).map((action) => action.id);
      is(`${role}, ${name}: exactly the actions unit 1 would show`, ids(offered), want);
      is(`${role}, ${name}: each one where unit 1 sends it`, offered.map((entry) => entry.href), want.map((id) => resultFor(STUDIO_ACTIONS.find((action) => action.id === id)!, ctx, href)!.href));
      // The same answer as unit 1's own search, for every query, from the list alone.
      for (const query of ["dicount", "refunds", "send emails", "zoom", "discord", "change price", "how do i get paid", "blog", "afiliate"])
        is(`${role}, ${name}: "${query}" finds what unit 1 finds`, ids(matchActions(query, offered)), ids(searchActions(query, ctx, href)));
    }
  }
  const owner = offeredFor(context("owner"), href);
  is("an action on the home opens its section", owner.find((entry) => entry.id === "sale")?.href, "/studio?store=s1#sale-title");
  is("an action of a module names it, so the same tool is not shown twice", owner.find((entry) => entry.id === "blog")?.module, "blog");
  is("an action on the home names no module", owner.find((entry) => entry.id === "sale")?.module, null);
  const notPro = offeredFor(context("owner", { pro: false }), href).find((entry) => entry.id === "email");
  is("a module the plan does not include opens the plan, and says which", [notPro?.href, notPro?.plan], [PLAN_HREF, "Studio"]);
  is("with no plan page, it is not offered at all", offeredFor(context("owner", { pro: false, planHref: null }), href).some((entry) => entry.id === "email"), false);
  is("support is offered no store-wide sale, no refund of the plan, no team", ["sale", "refund", "team"].map((id) => owner.some((entry) => entry.id === id) && offeredFor(context("support"), href).some((entry) => entry.id === id)), [false, false, false]);

  part("What the box shows: only what was offered, never an id it does not know");
  const sale = owner.find((entry) => entry.id === "sale")!;
  is("a typo finds the sale", ids(matchActions("dicount", owner)), ["sale"]);
  is("the result says what it does and where it goes", matchActions("dicount", owner)[0], { id: "sale", title: "Put the whole store on sale", detail: "Opens that part of your studio's home.", href: sale.href });
  is("a screen of its own says so", matchActions("blog", owner).find((result) => result.id === "blog")?.detail, "Opens the screen that does it.");
  const planned = offeredFor(context("owner", { pro: false }), href);
  is("a module of another plan says which plan, and that it opens the plan", matchActions("newsletter", planned).find((result) => result.id === "email")?.detail, "Needs the Studio plan. Opens your plan.");
  is("an action that was not offered is never shown, however well it matches", ids(matchActions("dicount", owner.filter((entry) => entry.id !== "sale"))), []);
  is("an id the box does not know is never shown", ids(matchActions("dicount", [{ id: "sale-everything", href: "/studio?store=s1#x", plan: null, module: null }])), []);
  is("an offered list that is not a list shows nothing", ids(matchActions("dicount", null as unknown as [])), []);
  is("the same action offered twice is shown once", ids(matchActions("dicount", [sale, sale])), ["sale"]);
  // "co" starts more than a group's worth of their words.
  const fitting = owner.filter((entry) => score(termsOf("co"), STUDIO_ACTIONS.find((action) => action.id === entry.id)!) > 0).length;
  is(`at most ${PER_GROUP} actions, the best of more`, [fitting > PER_GROUP, matchActions("co", owner).length], [true, PER_GROUP]);
  is("the offered order does not change the answer", ids(matchActions("refunds", [...owner].reverse())), ids(matchActions("refunds", owner)));
  is("small words alone find nothing", ids(matchActions("how do i", owner)), []);

  part("The group, first, and no tool twice");
  const routeAnswer: SearchAnswer = {
    groups: [
      { id: "products", title: "Products", state: "ok", missing: 0, results: [{ id: "p1", title: "Blog course", detail: "Product. Opens its sales page.", href: "/studio/pages?store=s1&product=p1" }] },
      {
        id: "tools",
        title: "Tools",
        state: "ok",
        missing: 0,
        results: [
          { id: "blog", title: "Blog", detail: "Posts.", href: "/studio/blog?store=s1" },
          { id: "forms", title: "Forms", detail: "Forms.", href: "/studio/forms?store=s1" },
        ],
      },
    ],
  };
  const merged = withActions("blog", owner, routeAnswer);
  is("the actions come first, then the route's groups in their order", merged.groups.map((group) => group.id), ["actions", "products", "tools"]);
  is(`the group is called "${ACTIONS_TITLE}"`, [merged.groups[0].title, ACTIONS_TITLE], ["Things to do", "Things to do"]);
  is("the group is whole: nothing was read for it", [merged.groups[0].state, merged.groups[0].missing], ["ok", 0]);
  is("the Blog tool is not shown again under the action that opens it; Forms stays", ids(merged.groups[2].results), ["forms"]);
  is("the route's answer itself is not changed", ids(routeAnswer.groups[1].results), ["blog", "forms"]);
  is("a tool is kept when no action shown opens it", ids(withActions("forms course", owner, routeAnswer).groups.find((group) => group.id === "tools")!.results), ["blog", "forms"]);
  is("with no answer from the route yet (or a refusal), the actions alone", withActions("blog", owner, null).groups.map((group) => group.id), ["actions"]);
  is("an address is never searched as an action", withActions("blog@example.com", owner, null).groups.flatMap((group) => group.results), []);
  is("too few letters is no search", withActions("b", owner, null).groups.flatMap((group) => group.results), []);
  const counted = merged.groups[0].results.length;
  is("the sentence counts the actions with the rest", answerSentence(merged, "blog"), `${counted + 2} results: ${counted} ${counted === 1 ? "action" : "actions"}, 1 product, 1 tool.`);
  is("one action alone", answerSentence(withActions("dicount", owner, { groups: [] }), "dicount"), "1 result: 1 action.");
  is("nothing, said once", answerSentence(withActions("zzzz", owner, { groups: [] }), "zzzz"), "Nothing matches “zzzz”.");

  part("The server's list for a real store and role");
  redis.clear();
  const email = "it3-actions@example.com";
  await claimHandle(email, "itthree", "IT3 Store", "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  await setSubscription(email, { customerId: "cus_it3", subscriptionId: "sub_it3", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(email))!;
  let sent = 0;
  const realPipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    sent += commands.length;
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  const lists = Object.fromEntries((["owner", "admin", "editor", "support"] as Role[]).map((role) => [role, server.offeredActions(store, role)]));
  is("working the list out sends Redis no command at all", sent, 0);
  for (const role of ["owner", "admin", "editor", "support"] as Role[]) {
    const ctx = server.studioGalleryContext(store, role)!;
    is(`${role}: the list is unit 1's for this store's own gallery`, ids(lists[role]), ids(offeredFor(ctx, (segment) => studioPath(store, "", segment))));
    is(`${role}: every link is this store's studio`, lists[role].every((entry) => entry.href.startsWith("/studio") && entry.href.includes(`store=${encodeURIComponent(store.sid)}`)), true);
    is(`${role}: no action its role may not open`, lists[role].every((entry) => {
      const action = STUDIO_ACTIONS.find((one) => one.id === entry.id)!;
      return action.permission === "member" || can(role, action.permission);
    }), true);
  }
  is("the owner may put the store on sale; support may not", [lists.owner.some((entry) => entry.id === "sale"), lists.support.some((entry) => entry.id === "sale")], [true, false]);
  is("Discord is not set up here, so no one is offered it", Object.values(lists).some((list) => list.some((entry) => entry.id === "discord")), false);
  is("a role it does not know is offered nothing, and nothing breaks", server.offeredActions(store, "ghost" as Role), []);
  is("a role it does not know has no gallery", server.studioGalleryContext(store, "toString" as Role), null);
  const tools = (await studioSearch(store, "owner", "blog")).groups.find((group) => group.id === "tools")!;
  const ctxOwner = server.studioGalleryContext(store, "owner")!;
  is("the search's tools come from the same gallery as the actions", ids(tools.results).every((id) => STUDIO_MODULES.some((module) => module.id === id && available({ id, title: "", segment: module.segment, permission: module.permission, words: [] }, ctxOwner))), true);

  part("The box and the top bar");
  const box = readFileSync("components/studio-search.tsx", "utf8");
  is("the box merges the actions in the browser, with no request of their own", box.includes("withActions(") && !box.includes("/api/store/studio-actions"), true);
  is("the sentence read out counts the actions", /answerSentence\(withActions\(/.test(box), true);
  for (const buyers of [true, false]) {
    const served = renderToStaticMarkup(createElement(StudioSearch, { sid: "s1", buyers, actions: owner }));
    is(`the hint says what can be typed (buyers ${buyers})`, served.includes("Type what you want to do"), true);
    is(`no action is drawn before anything is typed (buyers ${buyers})`, served.includes(ACTIONS_TITLE), false);
  }
  is("the box draws without a list of actions", renderToStaticMarkup(createElement(StudioSearch, { sid: "s1", buyers: false })).includes("Search the studio"), true);
  const header = readFileSync("components/studio-header.tsx", "utf8");
  is("the top bar gives the box the role's own actions for this store", /<StudioSearch[^>]*actions=\{offeredActions\(current, role\)\}/.test(header), true);
  const actionsSource = readFileSync("lib/studio-actions.ts", "utf8");
  is("the list and its matching import nothing of the gallery, so the browser does not carry it", /from "@\/lib\/studio-modules"/.test(actionsSource), false);
  const rules = readFileSync("lib/studio-search-actions.ts", "utf8");
  is("the box's rules hold nothing of the server's (no Redis, no settings)", ["@/lib/redis", "@/lib/store\"", "process.env", "@/lib/discord", "@/lib/billing"].some((piece) => rules.includes(piece)), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
