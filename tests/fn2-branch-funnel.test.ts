/**
 * 526 [FN2], unit 5: a "Conditional path" step inside a funnel of pages
 * (lib/funnel-branch-rules.ts, lib/page-funnel.ts, lib/page-funnel-store.ts,
 * app/[handle]/go/[funnel]/route.ts, app/api/store/page-funnels/route.ts).
 *
 * What fails here:
 *   - a good branch not read, or a bad one saved instead of refused with its
 *     own error ("branch");
 *   - a page or product counted twice across the funnel and its branches, or
 *     a branch's destinations not counted against the twenty pages;
 *   - a rule other than the first matching one winning, or "otherwise" not
 *     taken when nothing matches;
 *   - something unknown about the visit (no tag, no browser name, no word on
 *     the offer before) taken as a match: unknown is unknown, never "no";
 *   - a destination that cannot be shown chosen, or a branch with none open
 *     leading to a dead end instead of being passed over;
 *   - the funnel's address not sending by utm_campaign or by device;
 *   - anything about the person stored for a visit (a new key or a write);
 *   - a funnel without a branch behaving any differently.
 */
import { NextRequest } from "next/server";
import {
  type PageFunnelStep,
  MAX_FUNNEL_PAGES,
  funnelPlaces,
  parseSteps,
  readFunnelInput,
  sameSteps,
  stepIndex,
} from "@/lib/page-funnel";
import { BRANCH_MAX_RULES, branchPick, visitDevice } from "@/lib/funnel-branch-rules";
import { funnelHere, stepStates, stepTarget, writePageFunnel } from "@/lib/page-funnel-store";
import { addProduct, claimHandle, ensureStatsId, setSitePages, storeForEmail } from "@/lib/store";
import { productSegment } from "@/lib/product-slug";
import { GET as goRoute } from "@/app/[handle]/go/[funnel]/route";
import { POST as saveRoute } from "@/app/api/store/page-funnels/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
const NOW = 1_760_000_000;
const OWNER = "branch@example.com";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const page = (id: string) => ({ kind: "page" as const, id });
const product = (id: string) => ({ kind: "product" as const, id });
type Rule = { if: string; value?: string; to: { kind: "page" | "product"; id: string } };
const branch = (id: string | undefined, rules: Rule[], otherwise: { kind: "page" | "product"; id: string } | null) => ({
  kind: "branch",
  ...(id === undefined ? {} : { id }),
  rules,
  ...(otherwise ? { otherwise } : {}),
});

async function main(): Promise<void> {
  redis.clear();

  part("Reading a funnel with a conditional path");
  const read = parseSteps([page("landing01"), branch("brancha001", [{ if: "campaign", value: "Spring-Sale", to: page("spring01") }, { if: "phone", to: page("mobile01") }], page("default01")), product("course001")]);
  is("a branch is kept, its tag cleaned the way visits are counted", read, [
    page("landing01"),
    { kind: "branch", id: "brancha001", rules: [{ if: "campaign", value: "spring-sale", to: page("spring01") }, { if: "phone", to: page("mobile01") }], otherwise: page("default01") },
    product("course001"),
  ]);
  is("its places, in order, the default last", funnelPlaces({ steps: read }).map((p) => p.id), ["landing01", "spring01", "mobile01", "default01", "course001"]);
  is("a branch without a default is not read", parseSteps([branch("brancha001", [{ if: "phone", to: page("a1") }], null)]), []);
  is("a branch with no rule, or more than four, is not read", [
    parseSteps([branch("brancha001", [], page("d1"))]),
    parseSteps([branch("brancha001", Array.from({ length: BRANCH_MAX_RULES + 1 }, (_, i) => ({ if: "campaign", value: `c${i}`, to: page(`p${i}`) })), page("d1"))]),
  ], [[], []]);
  is("a rule on a tag with no value, or an unknown condition, is not read", [
    parseSteps([branch("brancha001", [{ if: "campaign", value: " ", to: page("a1") }], page("d1"))]),
    parseSteps([branch("brancha001", [{ if: "country", value: "br", to: page("a1") }], page("d1"))]),
  ], [[], []]);
  is("a page twice inside one branch is not read", parseSteps([branch("brancha001", [{ if: "phone", to: page("a1") }], page("a1"))]), []);
  is("a branch repeating a page of another step is left out", parseSteps([page("a1"), branch("brancha001", [{ if: "phone", to: page("a1") }], page("d1"))]).length, 1);
  is("the same branch is the same step; another rule starts the numbers again", [
    sameSteps(read, parseSteps(read)),
    sameSteps(read, parseSteps([read[0], { ...(read[1] as object), rules: [{ if: "computer", to: page("spring01") }, { if: "phone", to: page("mobile01") }] }, read[2]])),
  ], [true, false]);
  is("a destination of a branch is at the branch's place", [stepIndex({ steps: read }, "page", "spring01"), stepIndex({ steps: read }, "page", "default01"), stepIndex({ steps: read }, "product", "course001")], [1, 1, 2]);

  part("Which way a visitor goes");
  const step = read[1] as Extract<PageFunnelStep, { kind: "branch" }>;
  const all = () => true;
  is("the first rule that matches wins", branchPick(step, { campaign: "spring-sale", device: "phone" }, all)?.id, "spring01");
  is("the next rule when the first does not match", branchPick(step, { campaign: "fall", device: "phone" }, all)?.id, "mobile01");
  is("the default when none matches", branchPick(step, { campaign: "fall", device: "computer" }, all)?.id, "default01");
  is("nothing known about the visit: the default, never a guess", branchPick(step, {}, all)?.id, "default01");
  is("a matched page that cannot be shown falls to the next matching rule", branchPick(step, { campaign: "spring-sale", device: "phone" }, (p) => p.id !== "spring01")?.id, "mobile01");
  is("then to the default", branchPick(step, { campaign: "spring-sale", device: "computer" }, (p) => p.id !== "spring01")?.id, "default01");
  is("none can be shown: nothing (the funnel passes the step over)", branchPick(step, { campaign: "spring-sale" }, () => false), null);
  const offerStep = { kind: "branch" as const, id: "branchb001", rules: [{ if: "bought" as const, to: page("thanks01") }, { if: "declined" as const, to: page("downsell1") }], otherwise: page("other001") };
  is("bought, declined, and not known", [branchPick(offerStep, { bought: true }, all)?.id, branchPick(offerStep, { bought: false }, all)?.id, branchPick(offerStep, {}, all)?.id], ["thanks01", "downsell1", "other001"]);
  is("a phone and a computer, from the browser's name only; nothing named is unknown", [visitDevice(PHONE), visitDevice(DESKTOP), visitDevice(""), visitDevice(null)], ["phone", "computer", undefined, undefined]);

  part("What the studio sends");
  const good = readFunnelInput({ name: "Test", steps: [product("course001"), branch(undefined, [{ if: "declined", to: page("downsell1") }], page("other001"))] }, [], NOW);
  is("a new branch is given its own id", good.ok && /^[a-z0-9]{10}$/.test((good.funnel.steps[1] as { id: string }).id), true);
  const bad = (steps: unknown[]) => readFunnelInput({ name: "T", steps }, [], NOW);
  is("no default is refused with its own error", bad([branch(undefined, [{ if: "phone", to: page("a1") }], null)]), { ok: false, error: "branch" });
  is("a tag with no value is refused", bad([branch(undefined, [{ if: "source", value: "", to: page("a1") }], page("d1"))]), { ok: false, error: "branch" });
  is("bought or declined needs a product step just before it", [bad([page("p0"), branch(undefined, [{ if: "bought", to: page("a1") }], page("d1"))]), bad([branch(undefined, [{ if: "declined", to: page("a1") }], page("d1"))])], [{ ok: false, error: "branch" }, { ok: false, error: "branch" }]);
  is("a page twice across a branch is refused, not dropped", bad([page("a1"), branch(undefined, [{ if: "phone", to: page("a1") }], page("d1"))]), { ok: false, error: "steps" });
  const pages = (n: number, from = 0) => Array.from({ length: n }, (_, i) => page(`pg${String(i + from).padStart(6, "0")}`));
  is(`each destination counts against ${MAX_FUNNEL_PAGES} pages`, [
    bad([...pages(MAX_FUNNEL_PAGES - 2), branch(undefined, [{ if: "phone", to: page("x1") }], page("x2"))]).ok,
    bad([...pages(MAX_FUNNEL_PAGES - 1), branch(undefined, [{ if: "phone", to: page("x1") }], page("x2"))]),
  ], [true, { ok: false, error: "steps" }]);

  part("In a store");
  await claimHandle(OWNER, "branchshop", "Branch Shop", "");
  await ensureStatsId(OWNER);
  const course = await addProduct(OWNER, "Course", "", "99", null);
  if (!course.ok) throw new Error("no product");
  await setSitePages(OWNER, [
    { id: "landing001", slug: "start", title: "Start", nav: false, target: "", from: 0 },
    { id: "spring0001", slug: "spring", title: "Spring", nav: false, target: "", from: 0 },
    { id: "mobile0001", slug: "mobile", title: "Mobile", nav: false, target: "", from: 0 },
    { id: "default001", slug: "welcome", title: "Welcome", nav: false, target: "", from: 0 },
    { id: "downsell01", slug: "smaller", title: "Smaller", nav: false, target: "", from: 0 },
    { id: "bonus00001", slug: "bonus", title: "Bonus", nav: false, target: "", from: 0 },
  ]);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const coursePath = `/@branchshop/p/${productSegment(course.product)}`;
  const input = readFunnelInput({
    name: "Launch",
    steps: [
      branch(undefined, [{ if: "campaign", value: "spring", to: page("spring0001") }, { if: "phone", to: page("mobile0001") }], page("default001")),
      product(course.product.id),
      branch(undefined, [{ if: "declined", to: page("downsell01") }], page("bonus00001")),
    ],
  }, [], NOW);
  if (!input.ok) throw new Error("not read: " + JSON.stringify(input));
  const funnel = await writePageFunnel(statsId, input.funnel, [], ROOM);
  const states = await stepStates(store, funnel);
  is("a branch's state: open, with each destination's own, the default last", [states[0].open, states[0].path, states[0].options?.map((o) => o.path)], [true, null, ["/@branchshop/spring", "/@branchshop/mobile", "/@branchshop/welcome"]]);
  is("its target follows what is known of the visit", [stepTarget(states[0], 0, { campaign: "spring" }), stepTarget(states[0], 0, { device: "phone" }), stepTarget(states[0], 0)], ["/@branchshop/spring", "/@branchshop/mobile", "/@branchshop/welcome"]);
  const after = async (facts: Parameters<typeof funnelHere>[5]) => (await funnelHere(store, funnel.id, "product", course.product.id, undefined, facts))?.next;
  is("after the offer: declined goes to the smaller offer, bought or unknown to the default", [await after({ bought: false }), await after({ bought: true }), await after({})], [`/@branchshop/smaller?f=${funnel.id}`, `/@branchshop/bonus?f=${funnel.id}`, `/@branchshop/bonus?f=${funnel.id}`]);
  const inSpring = await funnelHere(store, funnel.id, "page", "spring0001");
  is("from a destination, the step after the branch", [inSpring?.index, inSpring?.next], [0, `${coursePath}?f=${funnel.id}`]);
  const tagged = await funnelHere(store, funnel.id, "page", "spring0001", undefined, { source: "news", campaign: "spring" });
  is("in a funnel that branches on a tag, the next link carries the tags along", tagged?.next, `${coursePath}?f=${funnel.id}&utm_source=news&utm_campaign=spring`);

  const go = async (query: string, agent: string | null) => {
    const headers = new Headers();
    if (agent !== null) headers.set("user-agent", agent);
    const response = await goRoute(new NextRequest(`https://marktmorgen.com/@branchshop/go/launch${query}`, { headers }), { params: Promise.resolve({ handle: "@branchshop", funnel: "launch" }) });
    return response.headers.get("location");
  };
  const keysBefore = redis.keys().sort();
  const writes: string[] = [];
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const command of commands) if (!["HVALS", "HGET", "HGETALL", "GET", "MGET", "SMEMBERS", "HMGET", "EXISTS", "TTL", "PTTL", "ZRANGE", "LRANGE", "SCARD", "HLEN", "TYPE", "ZSCORE", "SISMEMBER", "ZCARD", "LLEN", "HEXISTS"].includes(String(command[0]).toUpperCase())) writes.push(String(command[0]));
    return pipeline(commands);
  }) as typeof redis.pipeline;
  is("the funnel's address sends by utm_campaign, keeping the tags", await go("?utm_source=news&utm_campaign=Spring", DESKTOP), `https://marktmorgen.com/@branchshop/spring?f=${funnel.id}&utm_source=news&utm_campaign=Spring`);
  is("and by device", [await go("", PHONE), await go("", DESKTOP), await go("", null)], [`https://marktmorgen.com/@branchshop/mobile?f=${funnel.id}`, `https://marktmorgen.com/@branchshop/welcome?f=${funnel.id}`, `https://marktmorgen.com/@branchshop/welcome?f=${funnel.id}`]);
  redis.pipeline = pipeline;
  is("nothing about the person is stored for a visit: no write, no new key", [writes, redis.keys().sort()], [[], keysBefore]);
  await setSitePages(OWNER, [
    { id: "landing001", slug: "start", title: "Start", nav: false, target: "", from: 0 },
    { id: "spring0001", slug: "spring", title: "Spring", nav: false, target: "", from: -1 },
    { id: "mobile0001", slug: "mobile", title: "Mobile", nav: false, target: "", from: 0 },
    { id: "default001", slug: "welcome", title: "Welcome", nav: false, target: "", from: -1 },
    { id: "downsell01", slug: "smaller", title: "Smaller", nav: false, target: "", from: 0 },
    { id: "bonus00001", slug: "bonus", title: "Bonus", nav: false, target: "", from: 0 },
  ]);
  is("a matched page kept back falls through to the next match", await go("?utm_campaign=spring", PHONE), `https://marktmorgen.com/@branchshop/mobile?f=${funnel.id}&utm_campaign=spring`);
  is("nothing that matches can be shown: the branch is passed over", await go("?utm_campaign=spring", DESKTOP), `https://marktmorgen.com${coursePath}?f=${funnel.id}&utm_campaign=spring`);

  part("Saving through the studio");
  const session = await openSession(OWNER);
  const save = async (steps: unknown[]) =>
    (await saveRoute(new NextRequest("https://marktmorgen.com/api/store/page-funnels", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ funnel: { name: "Second", steps } }) }))).json();
  is("a bad branch is refused with its own error", (await save([branch(undefined, [{ if: "phone", to: page("landing001") }], null)])).error, "branch");
  is("a branch naming a page the store does not have is refused", (await save([branch(undefined, [{ if: "phone", to: page("landing001") }], page("nopage0001"))])).error, "page");
  const saved = await save([branch(undefined, [{ if: "computer", to: page("landing001") }], product(course.product.id))]);
  is("a good branch is kept", [saved.ok, saved.funnel?.steps?.[0]?.kind, saved.funnel?.steps?.[0]?.rules?.length], [true, "branch", 1]);

  part("Carried elsewhere");
  const { buildBundle, leftOutWords } = await import("@/lib/funnel-bundle");
  const { copiedFunnel, emptyBlocksLeft } = await import("@/lib/store-copy-rules");
  const { readFunnelMutationResult } = await import("@/lib/funnel-mutation-response");
  const built = buildBundle({ name: "Launch", steps: funnel.steps, pages: new Map(), forms: new Map(), products: new Map() }, "own");
  is("a file leaves a conditional path out and says so in plain words", [built.left.branches, leftOutWords(built.left).some((w) => w.startsWith("2 conditional paths are left out"))], [2, true]);
  const left = emptyBlocksLeft();
  const copied = copiedFunnel(funnel, "copyfunnel", "launch", (id) => `n-${id}`.slice(0, 40), (id) => `n-${id}`.slice(0, 40), NOW, left);
  is("a store copy keeps a branch whose pages were all copied", [copied.steps[0], left.refs], [{ kind: "branch", id: (funnel.steps[0] as { id: string }).id, rules: [{ if: "campaign", value: "spring", to: page("n-spring0001") }, { if: "phone", to: page("n-mobile0001") }], otherwise: page("n-default001") }, 0]);
  const some = emptyBlocksLeft();
  const partial = copiedFunnel(funnel, "copyfunnel", "launch", (id) => (id === "bonus00001" ? "" : `n-${id}`), (id) => `n-${id}`, NOW, some);
  is("and leaves out, counted, a branch with a page not copied", [partial.steps.map((s) => s.kind), some.refs], [["branch", "product"], 1]);
  const request = { funnel: { name: "Third", slug: "third", on: true, steps: [{ kind: "branch", rules: [{ if: "phone", to: page("a1") }], otherwise: page("b1") }] as unknown as PageFunnelStep[] } };
  const answer = { ok: true, funnel: { id: "thirdfunnl", name: "Third", slug: "third", on: true, since: NOW, steps: [{ kind: "branch", id: "serverid01", rules: [{ if: "phone", to: page("a1") }], otherwise: page("b1") }] } };
  is("the editor confirms a save where the server gave a new branch its id", readFunnelMutationResult(200, answer, request).state, "confirmed");
  is("a refused branch reaches the editor as a refusal", readFunnelMutationResult(400, { ok: false, error: "branch" }, request), { state: "rejected", error: "branch" });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
