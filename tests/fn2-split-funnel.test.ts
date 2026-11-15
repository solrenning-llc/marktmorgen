/**
 * 526 [FN2], unit 2: a "Split test" step inside a funnel of pages
 * (lib/page-funnel.ts, lib/page-funnel-store.ts,
 * app/[handle]/go/[funnel]/route.ts, app/api/store/page-funnels/route.ts).
 * The rules of a split alone are unit 1 (tests/fn2-split-rules.test.ts).
 *
 * What fails here:
 *   - a funnel with a split not read, or a bad split saved instead of refused
 *     with its own error;
 *   - a page or product counted twice across the funnel and its splits, or a
 *     split's destinations not counted against the twenty pages of a funnel;
 *   - a page inside a split not knowing where it is, or its next step;
 *   - a split with a destination open passed over, or one with none open
 *     leading to a dead end;
 *   - a draw that ignores the shares, or a destination off the air drawn;
 *   - the funnel's address not sending a visitor to one of a split's pages;
 *   - the editor without words for the new refusal;
 *   - a funnel without a split behaving any differently (tests/page-funnel.test.ts).
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import {
  MAX_FUNNEL_PAGES,
  type PageFunnelStep,
  funnelPlaces,
  nextOpen,
  parseSteps,
  readFunnelInput,
  sameSteps,
  splitPick,
  stepIndex,
} from "@/lib/page-funnel";
import { funnelHere, stepStates, stepTarget, writePageFunnel } from "@/lib/page-funnel-store";
import { addProduct, claimHandle, ensureStatsId, setProductHidden, setSitePages, storeForEmail } from "@/lib/store";
import { productSegment } from "@/lib/product-slug";
import { GET as goRoute } from "@/app/[handle]/go/[funnel]/route";
import { POST as saveRoute } from "@/app/api/store/page-funnels/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
const NOW = 1_760_000_000;
const OWNER = "split@example.com";

const page = (id: string) => ({ kind: "page" as const, id });
const product = (id: string) => ({ kind: "product" as const, id });
const split = (id: string | undefined, options: { kind: "page" | "product"; id: string; share?: number }[]) => ({ kind: "split", ...(id === undefined ? {} : { id }), options });

async function main(): Promise<void> {
  redis.clear();

  part("Reading a funnel with a split");
  const read = parseSteps([page("landing01"), split("splitaaaaa", [page("versiona1"), page("versionb1")]), product("course001")]);
  is("a split step is kept, its shares equal by default", read, [
    page("landing01"),
    { kind: "split", id: "splitaaaaa", options: [{ kind: "page", id: "versiona1", share: 50 }, { kind: "page", id: "versionb1", share: 50 }] },
    product("course001"),
  ]);
  is("a split with chosen shares keeps them", (parseSteps([split("splitaaaaa", [{ ...page("a1"), share: 70 }, { ...page("b1"), share: 30 }])])[0] as { options: { share: number }[] }).options.map((o) => o.share), [70, 30]);
  is("a split repeating a page step is left out", parseSteps([page("landing01"), split("splitaaaaa", [page("landing01"), page("other001")])]).length, 1);
  is("a page step repeating a split's page is left out", parseSteps([split("splitaaaaa", [page("a1"), page("b1")]), page("b1")]).length, 1);
  is("two splits with the same id: the second is left out", parseSteps([split("splitaaaaa", [page("a1"), page("b1")]), split("splitaaaaa", [page("c1"), page("d1")])]).length, 1);
  is("a split without a valid id, or that parseSplit refuses, is not read", [parseSteps([split("BAD!", [page("a1"), page("b1")])]), parseSteps([split("splitaaaaa", [page("a1")])])], [[], []]);
  is("its places, in order", funnelPlaces({ steps: read }).map((p) => p.id), ["landing01", "versiona1", "versionb1", "course001"]);

  part("What the studio sends");
  const good = readFunnelInput({ name: "Test", steps: [page("landing01"), split(undefined, [page("versiona1"), product("course001")])] }, [], NOW);
  const minted = good.ok ? (good.funnel.steps[1] as { id: string }).id : "";
  is("a new split is given its own id", /^[a-z0-9]{10}$/.test(minted), true);
  const kept = good.ok ? readFunnelInput({ id: good.funnel.id, name: "Test", slug: good.funnel.slug, steps: good.funnel.steps }, [good.funnel], NOW + 9) : null;
  is("a saved split keeps its id, and the numbers keep counting", kept?.ok ? [(kept.funnel.steps[1] as { id: string }).id, kept.funnel.since] : null, [minted, NOW]);
  is("one destination is no split test", readFunnelInput({ name: "T", steps: [split(undefined, [page("a1")])] }, [], NOW), { ok: false, error: "split" });
  is("shares that do not add up to 100", readFunnelInput({ name: "T", steps: [split(undefined, [{ ...page("a1"), share: 60 }, { ...page("b1"), share: 30 }])] }, [], NOW), { ok: false, error: "split" });
  is("a split id that is not one", readFunnelInput({ name: "T", steps: [split("NOPE", [page("a1"), page("b1")])] }, [], NOW), { ok: false, error: "split" });
  is("a page twice across a split is refused, not dropped", readFunnelInput({ name: "T", steps: [page("a1"), split(undefined, [page("a1"), page("b1")])] }, [], NOW), { ok: false, error: "steps" });
  const pages = (n: number, from = 0) => Array.from({ length: n }, (_, i) => page(`pg${String(i + from).padStart(6, "0")}`));
  is(`each destination counts against ${MAX_FUNNEL_PAGES} pages`, [
    readFunnelInput({ name: "T", steps: [...pages(MAX_FUNNEL_PAGES - 2), split(undefined, pages(2, 100))] }, [], NOW).ok,
    readFunnelInput({ name: "T", steps: [...pages(MAX_FUNNEL_PAGES - 1), split(undefined, pages(2, 100))] }, [], NOW),
  ], [true, { ok: false, error: "steps" }]);
  const a: PageFunnelStep[] = [split("splitaaaaa", [page("a1"), page("b1")]) as PageFunnelStep];
  const reread = parseSteps(a);
  is("other shares are other steps: the numbers start again", sameSteps(reread, parseSteps([split("splitaaaaa", [{ ...page("a1"), share: 60 }, { ...page("b1"), share: 40 }])])), false);
  is("the same split is the same step", sameSteps(reread, parseSteps(a)), true);

  part("Where a page inside a split is, and what is next");
  const steps = read;
  is("a version's page is at its split's place", [stepIndex({ steps }, "page", "versiona1"), stepIndex({ steps }, "page", "versionb1"), stepIndex({ steps }, "product", "course001"), stepIndex({ steps }, "page", "nope")], [1, 1, 2, -1]);
  is("a split with one destination open is open", nextOpen({ steps }, 0, (p) => p.id === "versionb1" || p.id === "course001"), 1);
  is("a split with none open is passed over", nextOpen({ steps }, 0, (p) => p.id === "course001"), 2);
  const shares = { kind: "split" as const, id: "splitaaaaa", options: [{ kind: "page" as const, id: "a1", share: 70 }, { kind: "page" as const, id: "b1", share: 30 }] };
  is("the draw honors the shares", [0, 0.69, 0.7, 0.999].map((d) => splitPick(shares, () => true, d)?.id), ["a1", "a1", "b1", "b1"]);
  is("each with its version name", [splitPick(shares, () => true, 0.1)?.version, splitPick(shares, () => true, 0.9)?.version], ["a", "b"]);
  is("a destination off the air is never drawn", [0, 0.5, 0.99].map((d) => splitPick(shares, (p) => p.id !== "a1", d)?.id), ["b1", "b1", "b1"]);
  is("none open, nothing drawn", splitPick(shares, () => false, 0.5), null);

  part("In a store");
  await claimHandle(OWNER, "splitshop", "Split Shop", "");
  await ensureStatsId(OWNER);
  const course = await addProduct(OWNER, "Course", "", "99", null);
  const offer = await addProduct(OWNER, "Offer B", "", "49", null);
  if (!course.ok || !offer.ok) throw new Error("no product");
  await setSitePages(OWNER, [
    { id: "landing001", slug: "start", title: "Start", nav: false, target: "", from: 0 },
    { id: "versiona01", slug: "offer-a", title: "Offer A", nav: false, target: "", from: 0 },
  ]);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const input = readFunnelInput({ name: "Launch", steps: [page("landing001"), split(undefined, [{ ...page("versiona01"), share: 60 }, { ...product(offer.product.id), share: 40 }]), product(course.product.id)] }, [], NOW);
  if (!input.ok) throw new Error("not read: " + JSON.stringify(input));
  const funnel = await writePageFunnel(statsId, input.funnel, [], ROOM);
  const offerPath = `/@splitshop/p/${productSegment(offer.product)}`;
  const coursePath = `/@splitshop/p/${productSegment(course.product)}`;
  const states = await stepStates(store, funnel);
  is("a split's state: open, with each destination's own", [states[1].open, states[1].path, states[1].options?.map((o) => [o.title, o.open, o.path])], [true, null, [["Offer A", true, "/@splitshop/offer-a"], ["Offer B", true, offerPath]]]);
  is("its target follows the draw", [stepTarget(states[1], 0.1), stepTarget(states[1], 0.7), stepTarget(states[0], 0.7)], ["/@splitshop/offer-a", offerPath, "/@splitshop/start"]);
  const fromStart = async (draw: number) => (await funnelHere(store, funnel.id, "page", "landing001", () => draw))?.next;
  is("from the page before it, a visitor goes to one version, with the funnel's mark", [await fromStart(0.1), await fromStart(0.9)], [`/@splitshop/offer-a?f=${funnel.id}`, `${offerPath}?f=${funnel.id}`]);
  const inA = await funnelHere(store, funnel.id, "page", "versiona01");
  const inB = await funnelHere(store, funnel.id, "product", offer.product.id);
  is("from either version, the step after the split", [inA?.index, inA?.next, inB?.index, inB?.next], [1, `${coursePath}?f=${funnel.id}`, 1, `${coursePath}?f=${funnel.id}`]);

  const go = async () => {
    const response = await goRoute(new NextRequest("https://marktmorgen.com/@splitshop/go/launch"), { params: Promise.resolve({ handle: "@splitshop", funnel: "launch" }) });
    return [response.status, response.headers.get("location")];
  };
  const opener = await writePageFunnel(statsId, { ...funnel, steps: funnel.steps.slice(1) }, [funnel], ROOM);
  const landed = new Set<string>();
  for (let i = 0; i < 40; i += 1) landed.add(String((await go())[1]));
  is("the funnel's address opening on a split sends each visitor to one of its versions", [...landed].sort(), [`https://marktmorgen.com${offerPath}?f=${funnel.id}`, `https://marktmorgen.com/@splitshop/offer-a?f=${funnel.id}`].sort());
  await setProductHidden(OWNER, offer.product.id, true);
  const onlyA = new Set<string>();
  for (let i = 0; i < 20; i += 1) onlyA.add(String((await go())[1]));
  is("a version off the air is never sent to", [...onlyA], [`https://marktmorgen.com/@splitshop/offer-a?f=${funnel.id}`]);
  await setSitePages(OWNER, [
    { id: "landing001", slug: "start", title: "Start", nav: false, target: "", from: 0 },
    { id: "versiona01", slug: "offer-a", title: "Offer A", nav: false, target: "", from: -1 },
  ]);
  is("with no version open, the split is passed over", await go(), [307, `https://marktmorgen.com${coursePath}?f=${funnel.id}`]);
  void opener;

  part("Saving through the studio");
  const session = await openSession(OWNER);
  const save = async (steps: unknown[]) =>
    (await saveRoute(new NextRequest("https://marktmorgen.com/api/store/page-funnels", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ funnel: { name: "Second", steps } }) }))).json();
  is("a bad split is refused with its own error", (await save([split(undefined, [page("landing001")])])).error, "split");
  is("a split naming a page the store does not have is refused", (await save([split(undefined, [page("landing001"), page("nopage0001")])])).error, "page");
  const saved = await save([split(undefined, [page("landing001"), product(course.product.id)])]);
  is("a good split is kept", [saved.ok, saved.funnel?.steps?.[0]?.kind, saved.funnel?.steps?.[0]?.options?.length], [true, "split", 2]);

  part("Carried elsewhere");
  const { buildBundle, leftOutWords } = await import("@/lib/funnel-bundle");
  const { copiedFunnel, emptyBlocksLeft } = await import("@/lib/store-copy-rules");
  const { readFunnelMutationResult } = await import("@/lib/funnel-mutation-response");
  const built = buildBundle({ name: "Launch", steps: funnel.steps, pages: new Map(), forms: new Map(), products: new Map() }, "own");
  is("a file leaves a split test out and says so in plain words", [built.left.splits, built.bundle.steps.some((s) => s.ref === "versiona01"), leftOutWords(built.left).some((w) => w.startsWith("1 split test is left out"))], [1, false, true]);
  const both = emptyBlocksLeft();
  const copied = copiedFunnel(funnel, "copyfunnel", "launch", (id) => `n-${id}`.slice(0, 40), (id) => `n-${id}`.slice(0, 40), NOW, both);
  is("a store copy keeps a split whose pages were all copied, with their copies and shares", [copied.steps[1], both.refs], [{ kind: "split", id: (funnel.steps[1] as { id: string }).id, options: [{ kind: "page", id: "n-versiona01", share: 60 }, { kind: "product", id: `n-${offer.product.id}`, share: 40 }] }, 0]);
  const some = emptyBlocksLeft();
  const partial = copiedFunnel(funnel, "copyfunnel", "launch", (id) => (id === "versiona01" ? "" : `n-${id}`), (id) => `n-${id}`, NOW, some);
  is("and leaves out, counted, a split with a page not copied", [partial.steps.map((s) => s.kind), some.refs], [["page", "product"], 1]);
  const request = { funnel: { name: "Third", slug: "third", on: true, steps: [{ kind: "split", options: [page("a1"), page("b1")] }] as unknown as PageFunnelStep[] } };
  const answer = (id: string) => ({ ok: true, funnel: { id: "thirdfunnl", name: "Third", slug: "third", on: true, since: NOW, steps: [{ kind: "split", id, options: [{ kind: "page", id: "a1", share: 50 }, { kind: "page", id: "b1", share: 50 }] }] } });
  is("the editor confirms a save where the server gave a new split its id", readFunnelMutationResult(200, answer("serverid01"), request).state, "confirmed");
  is("and refuses a split it did not send", readFunnelMutationResult(200, { ...answer("serverid01"), funnel: { ...answer("serverid01").funnel, steps: [{ kind: "split", id: "serverid01", options: [{ kind: "page", id: "a1", share: 60 }, { kind: "page", id: "b1", share: 40 }] }] } }, request).state, "uncertain");
  is("a refused split reaches the editor as a refusal", readFunnelMutationResult(400, { ok: false, error: "split" }, request), { state: "rejected", error: "split" });

  part("The editor's words");
  const editor = readFileSync("components/page-funnel-editor.tsx", "utf8");
  is("the editor explains the refusal in plain words", /\n\s*split: "[^"]{20,}",/.test(editor), true);
  is("the editor shows a saved split's destinations and shares as text", /Split test/.test(editor) && /share\}%/.test(editor), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
