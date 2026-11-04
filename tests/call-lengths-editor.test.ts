/**
 * Saving a call's other lengths from the studio (637 [GL5], unit 3; added
 * 3 November 2026), called as the studio calls it, on the in-memory store
 * with Stripe mocked: the call's own length first at the product's price,
 * each other one longer at its own price, checked with the store's currency
 * and the rules (lib/call-lengths.ts, readCallLengths); never a list sent
 * from outside, never with a package or a team; the editor's summary says
 * each length; the rows drawn mark the field a refusal is about; a new price
 * on the product says, when saved, that only the call's own length sells.
 */
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { POST as saveCall } from "@/app/api/store/call/route";
import { POST as saveTeam } from "@/app/api/store/call-team/route";
import { CallEditor, MESSAGES, OtherLengths } from "@/components/call-editor";
import { POST as saveProduct } from "@/app/api/store/product/route";
import { OWN_PRICE, SHORTER_LENGTH, lengthsProblemWords, lengthsRefusal } from "@/lib/call-lengths";
import { lengthsPausedWords } from "@/lib/extras-notes";
import { addProduct, chargesBelow, claimHandle, ensureStatsId, setCallPackage, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readSetup, type CallSetup } from "@/lib/call-setup";
import { readProduct } from "@/lib/catalog";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "lena@example.com";
const NY = "America/New_York";
const WEEK: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const call = { kind: "weekly", minutes: 30, tz: NY, weekly: WEEK, noticeHours: 12, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1 };

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_call_lengths_editor";
  await claimHandle(OWNER, "lena", "Lena Coaching", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLena00001", true);
  await setSubscription(OWNER, { customerId: "cus_lena00001", subscriptionId: "sub_lena00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Coaching", "", "45", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const post = async (route: typeof saveCall, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`https://marktmorgen.com/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify(body) }));
    return (await response.json()) as { ok: boolean; error?: string; problem?: string; minutes?: number };
  };
  const kept = async () => (await readProduct((await storeForEmail(OWNER))!, id))?.call?.lengths;

  part("Saved from the studio");
  is("the call's own length first, at the product's price, then each other one at its own", [(await post(saveCall, "call", { id, call, lengths: [{ minutes: 60, price: "80" }, { minutes: 90, price: "110.50" }] })).ok, await kept()], [true, [{ minutes: 30, cents: 4500 }, { minutes: 60, cents: 8000 }, { minutes: 90, cents: 11050 }]]);
  is("saved with none, the call has one length again", [(await post(saveCall, "call", { id, call, lengths: [] })).ok, await kept()], [true, undefined]);
  is("and saved without the field, too", [(await post(saveCall, "call", { id, call: { ...call } })).ok, await kept()], [true, undefined]);

  part("Refused, saying why");
  const refused = await Promise.all([
    post(saveCall, "call", { id, call, lengths: [{ minutes: 60, price: "0" }] }),
    post(saveCall, "call", { id, call, lengths: [{ minutes: 60, price: "80" }, { minutes: 60, price: "90" }] }),
    post(saveCall, "call", { id, call: { ...call, minutes: 60 }, lengths: [{ minutes: 30, price: "20" }] }),
    post(saveCall, "call", { id, call: { ...call, weekly: [[], [[540, 600]], [], [], [], [], []] }, lengths: [{ minutes: 90, price: "110" }] }),
    post(saveCall, "call", { id, call: { ...call, seats: 3 }, lengths: [{ minutes: 60, price: "80" }] }),
    post(saveCall, "call", { id, call, lengths: [{ minutes: 45, price: "60" }, { minutes: 60, price: "80" }, { minutes: 90, price: "110" }] }),
  ]);
  is("no price, twice, shorter than the call's own, too long for the hours, a group, more than three in all", refused.map((r) => [r.ok, r.error, r.problem, r.minutes ?? null]), [[false, "lengths", "price", null], [false, "lengths", "twice", null], [false, "lengths", "shorter", null], [false, "lengths", "fits", 90], [false, "lengths", "kind", null], [false, "lengths", "too_many", null]]);
  is("a stored list sent from outside is never taken", (await post(saveCall, "call", { id, call: { ...call, lengths: [{ minutes: 30, cents: 4500 }, { minutes: 60, cents: 1 }] } })).error, "lengths");
  is("nothing was kept by any of them", await kept(), undefined);

  part("Never with a package or a team");
  await setCallPackage(OWNER, id, { sessions: 5, priceCents: 20000, days: 0 });
  is("a call sold in packages keeps one length", (await post(saveCall, "call", { id, call, lengths: [{ minutes: 60, price: "80" }] })).problem, "package");
  await setCallPackage(OWNER, id, null);
  await post(saveCall, "call", { id, call, lengths: [{ minutes: 60, price: "80" }] });
  is("and a call with several lengths takes no package", await setCallPackage(OWNER, id, { sessions: 5, priceCents: 20000, days: 0 }), { ok: false, reason: "lengths" });
  is("nor a team", (await post(saveTeam as typeof saveCall, "call-team", { id, team: { hosts: [{ email: OWNER }], mode: "round" } })).error, "team_lengths");
  const withLengths = readSetup({ ...call, sessions: [], lengths: [{ minutes: 30, cents: 4500 }, { minutes: 60, cents: 8000 }] }) as CallSetup;
  await post(saveCall, "call", { id, call, lengths: [] });
  await setCallPackage(OWNER, id, { sessions: 5, priceCents: 20000, days: 0 });
  is("read again under the record's own write: a package that came in meanwhile refuses the lengths", await setProductCall(OWNER, id, withLengths), { ok: false, reason: "lengths_package" });
  await setCallPackage(OWNER, id, null);
  is("and so does a price changed meanwhile", await setProductCall(OWNER, id, readSetup({ ...call, sessions: [], lengths: [{ minutes: 30, cents: 5000 }, { minutes: 60, cents: 8000 }] }) as CallSetup), { ok: false, reason: "lengths_price" });
  is("the route says which line is wrong", (await post(saveCall, "call", { id, call, lengths: [{ minutes: 60, price: "80" }, { minutes: 90, price: "0" }] })) as unknown, { ok: false, error: "lengths", problem: "price", index: 2 });

  part("A change of the store's currency");
  const low = { ...(await readProduct((await storeForEmail(OWNER))!, id))!, call: readSetup({ ...call, sessions: [], lengths: [{ minutes: 30, cents: 4500 }, { minutes: 60, cents: 500 }] }) as CallSetup };
  is("an other length's price below the new currency's smallest charge is said, as every other price is", chargesBelow([low], "sek").filter((c) => c.what === "length").map((c) => [c.label, c.amount]), [["60 minutes", 500]]);

  part("In the studio");
  await post(saveCall, "call", { id, call, lengths: [{ minutes: 60, price: "80" }] });
  const product = (await readProduct((await storeForEmail(OWNER))!, id))!;
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never }, createElement(CallEditor, { product, email: OWNER })));
  is("the summary says each length", html.includes("Paid call · 30, 60 minutes · America/New_York"), true);
  const inPerson = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never }, createElement(CallEditor, { product: { ...product, call: { ...product.call!, place: { lines: ["1 Main St", "Austin"] } } }, email: OWNER })));
  is("in person, the summary says each length too, as the store does", inPerson.includes("In person · 30, 60 minutes · America/New_York"), true);
  const editorSource = readFileSync("components/call-editor.tsx", "utf8");
  // Inside the open editor, which a page drawn on the server never shows open: read in its source.
  is("with a package, the editor says before saving that the call has one length, and names the button that stops the package", [editorSource.includes("Number(draft.seats) === 1 && product.callPackage && !draft.extra.length ? ("), editorSource.includes("This call has a package of sessions, so it has one length. To offer other lengths, choose “Stop offering it” in the package first."), readFileSync("components/package-editor.tsx", "utf8").includes("Stop offering it")], [true, true, true]);
  const changed = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never }, createElement(CallEditor, { product: { ...product, priceCents: 5000 }, email: OWNER })));
  is("a price changed since says only the first length is on sale, and how to offer the others", changed.includes("only the first length is on sale. Open the hours and save them again to offer the others."), true);
  is("one person a time only; a group says before saving that it removes the other lengths", [editorSource.includes(") : Number(draft.seats) === 1 ? ("), editorSource.includes("Saving it as a group removes the other lengths")], [true, true]);
  is("rows keep their own keys, and focus follows an added or removed row", [editorSource.includes("<div key={row.id}"), editorSource.includes("focusSoon(`length-${id}-${added.id}`)"), editorSource.includes("focusSoon(`lengths-hint-${id}`)")], [true, true, true]);

  part("The other lengths, drawn");
  type Wrong = { id: string; problem: string } | null;
  const rows = (minutes: number, wrong: Wrong, extra = [{ id: "r1", minutes: 60, price: "80" }, { id: "r2", minutes: 90, price: "110" }]) =>
    renderToStaticMarkup(createElement(OtherLengths, { draft: { minutes, extra } as never, setDraft: () => {}, currency: "usd", id: "p1", wrong, clearWrong: () => {}, errorId: "call-error-p1" }));
  const fieldsOf = (html: string, row: string) => {
    const select = html.match(new RegExp(`<select[^>]*id="length-p1-${row}"[^>]*>`))?.[0] ?? "";
    const input = html.split(`id="length-p1-${row}"`)[1]?.match(/<input[^>]*>/)?.[0] ?? "";
    return { length: select.includes('aria-invalid="true"'), price: input.includes('aria-invalid="true"'), lengthSaid: select.includes("call-error-p1"), priceSaid: input.includes("call-error-p1") };
  };
  const plain = rows(30, null);
  is(
    "a named group, each price with its hint, each row removable by name",
    [plain.includes('<legend class="field-label">Other lengths (optional)</legend>'), (plain.match(/<input[^>]*aria-describedby="lengths-price-p1"/g) ?? []).length, plain.includes(">Remove 60 minutes</button>"), plain.includes(">Remove 90 minutes</button>")],
    [true, 2, true, true],
  );
  // Only the field the problem is about is marked invalid (3.3.1): a price out of range or below a shorter length's on the price, any other on the length.
  is(
    "a price problem and a price below a shorter length's mark only the price; a length problem only the length; never another row",
    (["price", "cheaper", "fits", "twice", "shorter"] as const).map((problem) => [fieldsOf(rows(30, { id: "r2", problem }), "r2"), fieldsOf(rows(30, { id: "r2", problem }), "r1")]),
    [
      [{ length: false, price: true, lengthSaid: false, priceSaid: true }, { length: false, price: false, lengthSaid: false, priceSaid: false }],
      [{ length: false, price: true, lengthSaid: false, priceSaid: true }, { length: false, price: false, lengthSaid: false, priceSaid: false }],
      [{ length: true, price: false, lengthSaid: true, priceSaid: false }, { length: false, price: false, lengthSaid: false, priceSaid: false }],
      [{ length: true, price: false, lengthSaid: true, priceSaid: false }, { length: false, price: false, lengthSaid: false, priceSaid: false }],
      [{ length: true, price: false, lengthSaid: true, priceSaid: false }, { length: false, price: false, lengthSaid: false, priceSaid: false }],
    ],
  );
  const grown = rows(60, null);
  is(
    "a row no longer longer than the call's own is marked on itself, and said in a live region that was already there (4.1.3)",
    [fieldsOf(grown, "r1").length, fieldsOf(grown, "r2").length, /<div role="status"[^>]*><p id="length-short-p1-r1"[^>]*>60 minutes is not longer than the call&#x27;s own length of 60 minutes\./.test(grown), (plain.match(/<div role="status"[^>]*><\/div>/g) ?? []).length],
    [true, false, true, 2],
  );

  part("What a refused save says, and where");
  is(
    "every refusal of the lengths the route or the record can send has its own words, never \"something went wrong\"",
    ["lengths_package", "lengths_price", "lengths"].map((key) => Boolean(MESSAGES[key]) && MESSAGES[key] !== MESSAGES.server_error),
    [true, true, true],
  );
  is(
    "the call's own line: its price is the product's; \"cheaper\" on it is a shorter row, never a price to raise that is not changed there",
    [lengthsRefusal({ problem: "price", index: 0 }, "usd"), lengthsRefusal({ problem: "cheaper", index: 0, minutes: 60 }, "usd")],
    [{ message: OWN_PRICE, row: null, problem: "price" }, { message: SHORTER_LENGTH, row: null, problem: "shorter" }],
  );
  is(
    "a row's problem is said in the rules' words and marked on that row, counted from the first other length",
    [lengthsRefusal({ problem: "cheaper", index: 2, minutes: 90 }, "usd"), lengthsRefusal({ problem: "shorter", index: 1 }, "usd"), lengthsRefusal({ problem: "fits", index: 1, minutes: 90 }, "usd").row],
    [{ message: lengthsProblemWords("cheaper", "usd", 90), row: 2, problem: "cheaper" }, { message: SHORTER_LENGTH, row: 1, problem: "shorter" }, 1],
  );
  is("the editor reads the refusal through those rules and keeps the mark by the row's own id", [editorSource.includes("lengthsRefusal({ problem: data.problem, index: data.index, minutes: data.minutes }, currency)"), editorSource.includes("setWrongLength(sentRow ? { id: sentRow.id, problem: said.problem } : null)"), editorSource.includes('<p id={`call-error-${product.id}`} className="notice notice-error" role="alert">')], [true, true, true]);
  is(
    "a shorter row priced above the call's own is said as shorter, on its row, never as the call's own being cheaper",
    (await post(saveCall, "call", { id, call: { ...call, minutes: 60 }, lengths: [{ minutes: 90, price: "110" }, { minutes: 30, price: "80" }] })) as unknown,
    { ok: false, error: "lengths", problem: "shorter", index: 2 },
  );

  part("A new price on the product, said when it is saved");
  await post(saveCall, "call", { id, call, lengths: [{ minutes: 60, price: "80" }] });
  const editProduct = async (price: string) => {
    const response = await saveProduct(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify({ action: "edit", id, title: "Coaching", summary: "", price }) }));
    return (await response.json()) as { ok: boolean; quiet?: string[] };
  };
  is(
    "the same price: nothing said; a new one: the save says only the call's own length sells, and how to offer the others",
    [(await editProduct("45")).quiet ?? [], (await editProduct("50")).quiet ?? []],
    [[], [`Coaching: ${lengthsPausedWords(30)}`]],
  );
  is("in plain words, naming the button to use", lengthsPausedWords(30), "Buyers can book only the 30-minute length now, because the price changed. To offer the other lengths again, open “Change the hours” on this product and save.");
  is("saved again from the hours, the others sell, and nothing is said", [(await post(saveCall, "call", { id, call, lengths: [{ minutes: 60, price: "80" }] })).ok, (await editProduct("50")).quiet ?? []], [true, []]);
  is("the team and package editors say why", [readFileSync("components/team-event-editor.tsx", "utf8").includes("team_lengths:"), readFileSync("components/package-editor.tsx", "utf8").includes("lengths:")], [true, true]);
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
