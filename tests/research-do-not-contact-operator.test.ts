import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { POST as publicPost } from "@/app/api/privacy/do-not-contact/route";
import { POST as operatorPost } from "@/app/api/operator/do-not-contact/route";
import DoNotContactPage from "@/app/privacy/do-not-contact/page";
import { DoNotContactForm } from "@/components/do-not-contact-form";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import {
  ADD_DO_NOT_CONTACT,
  DO_NOT_CONTACT_DAY_PREFIX,
  DO_NOT_CONTACT_KEY,
  DO_NOT_CONTACT_PUBLIC_KEY,
  RESEARCH_DO_NOT_CONTACT_MAX,
  RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX,
  RESEARCH_STOP_NEW_PER_DAY,
  mayContactForResearch,
} from "@/lib/research-do-not-contact";
import { find, mount, texts } from "./client-hooks";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";

// What the pre-review asked of the research do-not-contact list beyond its
// first version: a ceiling on new public entries a day, room above the public
// ceiling that only the operator reaches (so "We will add you ourselves" is
// true), a confirmation before an entry that cannot be taken back from the
// page (WCAG 3.3.6), and a wrong entry kept in the field (3.3.7).

const OPERATOR = "operator@example.test";
let net = 0;

function request(path: string, fields: Record<string, string>, headers: Record<string, string> = {}): NextRequest {
  net += 1;
  return new NextRequest(`https://marktmorgen.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://marktmorgen.com",
      host: "marktmorgen.com",
      "x-forwarded-for": `10.${Math.floor(net / 250)}.${net % 250}.1`,
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
}
const pub = (contact: string, extra: Record<string, string> = {}) => publicPost(request("/api/privacy/do-not-contact", { contact, name: "", confirm: "yes", ...extra }));
const statusOf = (response: Response) => {
  assert.equal(response.status, 303);
  return new URL(response.headers.get("location")!).searchParams.get("status");
};
const today = () => `${DO_NOT_CONTACT_DAY_PREFIX}${new Date().toISOString().slice(0, 10)}`;

function fill(entries: number): void {
  for (let i = redis.run(["HLEN", DO_NOT_CONTACT_KEY]) as number; i < entries; i += 1) redis.run(["HSET", DO_NOT_CONTACT_KEY, `email:fill${i}@example.com`, ""]);
}

async function withOperator<T>(run: () => Promise<T>): Promise<T> {
  const before = process.env.DEMO_STUDIO_ADMIN;
  process.env.DEMO_STUDIO_ADMIN = OPERATOR;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.DEMO_STUDIO_ADMIN;
    else process.env.DEMO_STUDIO_ADMIN = before;
  }
}

test("the public form takes at most RESEARCH_STOP_NEW_PER_DAY requests a day, and says it the same way to someone already listed", async () => {
  redis.clear();
  assert.ok(RESEARCH_STOP_NEW_PER_DAY > 0 && RESEARCH_STOP_NEW_PER_DAY <= 500);
  assert.equal(statusOf(await pub("early@example.com")), "done");
  for (let i = 1; i < RESEARCH_STOP_NEW_PER_DAY; i += 1) assert.equal(statusOf(await pub(`day${i}@example.com`)), "done");
  assert.equal(redis.run(["HLEN", DO_NOT_CONTACT_KEY]), RESEARCH_STOP_NEW_PER_DAY);
  const unlisted = statusOf(await pub("late@example.com"));
  const listed = statusOf(await pub("early@example.com"));
  assert.equal(unlisted, "full");
  assert.equal(listed, unlisted, "the day's ceiling does not tell who is listed");
  assert.equal(await mayContactForResearch("late@example.com"), true, "nothing past the day's ceiling");
  const ttl = redis.run(["TTL", today()]) as number;
  assert.ok(ttl > 0 && ttl <= 2 * 86_400, `the day's count expires: ${ttl}`);
  redis.run(["DEL", today()]);
  assert.equal(statusOf(await pub("late@example.com")), "done", "a new day takes new entries");
});

test("the public form stops at its own ceiling; the operator adds above it, up to the list's", async () => {
  redis.clear();
  assert.ok(RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX < RESEARCH_DO_NOT_CONTACT_MAX);
  fill(RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX);
  // The public form is measured by its own count of requests taken, here at its ceiling.
  redis.run(["SET", DO_NOT_CONTACT_PUBLIC_KEY, String(RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX)]);
  assert.equal(statusOf(await pub("public@example.com")), "full");
  assert.equal(await mayContactForResearch("public@example.com"), true);
  await withOperator(async () => {
    const session = await openSession(OPERATOR);
    const asOperator = (contact: string) =>
      operatorPost(request("/api/operator/do-not-contact", { contact, name: "", confirm: "yes" }, { cookie: `${SESSION_COOKIE}=${session}`, "x-forwarded-for": "198.51.100.9" }));
    // Not counted per connection, nor by the public day.
    for (let i = 0; i < 8; i += 1) assert.equal(statusOf(await asOperator(`emailed${i}@example.com`)), "done");
    assert.equal(await mayContactForResearch("emailed3@example.com"), false);
    assert.equal(redis.run(["HLEN", DO_NOT_CONTACT_KEY]), RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX + 8);
    fill(RESEARCH_DO_NOT_CONTACT_MAX);
    assert.equal(statusOf(await asOperator("over@example.com")), "full");
    assert.equal(redis.run(["HLEN", DO_NOT_CONTACT_KEY]), RESEARCH_DO_NOT_CONTACT_MAX, "never past the list's ceiling");
  });
});

test("only the operator reaches the operator's route; anyone else is answered as if it did not exist", async () => {
  redis.clear();
  await withOperator(async () => {
    const stranger = await openSession("stranger@example.test");
    const operator = await openSession(OPERATOR);
    const tries = [
      request("/api/operator/do-not-contact", { contact: "a@example.com", confirm: "yes" }),
      request("/api/operator/do-not-contact", { contact: "a@example.com", confirm: "yes" }, { cookie: `${SESSION_COOKIE}=${stranger}` }),
      request("/api/operator/do-not-contact", { contact: "a@example.com", confirm: "yes" }, { cookie: `${SESSION_COOKIE}=${"f".repeat(64)}` }),
      request("/api/operator/do-not-contact", { contact: "a@example.com", confirm: "yes" }, { cookie: `${SESSION_COOKIE}=${operator}`, origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
    ];
    for (const one of tries) assert.equal((await operatorPost(one)).status, 404);
    assert.equal(redis.run(["HLEN", DO_NOT_CONTACT_KEY]), 0);
  });
  delete process.env.DEMO_STUDIO_ADMIN;
  assert.equal((await operatorPost(request("/api/operator/do-not-contact", { contact: "a@example.com", confirm: "yes" }))).status, 404, "no operator configured, nobody is one");
});

test("an entry is kept only after the person confirms it stays on the list", async () => {
  redis.clear();
  assert.equal(statusOf(await publicPost(request("/api/privacy/do-not-contact", { contact: "ana@example.com", name: "" }))), "confirm");
  assert.equal(statusOf(await publicPost(request("/api/privacy/do-not-contact", { contact: "ana@example.com", name: "", confirm: "no" }))), "confirm");
  assert.equal(await mayContactForResearch("ana@example.com"), true, "nothing kept unconfirmed");
  assert.equal(statusOf(await pub("ana@example.com")), "done");
});

type El = { type?: unknown; props?: Record<string, unknown> };
const byId = (tree: unknown, id: string) => find(tree, (n: El) => n.props?.id === id)[0] as El | undefined;

test("the form keeps what was typed when the contact does not read, says why at the field, and asks for confirmation", async () => {
  const view = await mount(DoNotContactForm, { status: "", operator: false });
  const form = find(view.tree(), (n: El) => n.type === "form")[0] as El;
  assert.equal(form.props!.action, "/api/privacy/do-not-contact");
  const contact = byId(view.tree(), "dnc-contact")!;
  (contact.props!.onChange as (e: unknown) => void)({ currentTarget: { value: "ana@example..com" }, target: { value: "ana@example..com" } });
  await view.settle();
  let prevented = false;
  (find(view.tree(), (n: El) => n.type === "form")[0].props!.onSubmit as (e: unknown) => void)({ preventDefault: () => { prevented = true; } });
  await view.settle();
  assert.equal(prevented, true, "a contact that does not read is not sent");
  const after = byId(view.tree(), "dnc-contact")!;
  assert.equal(after.props!.value, "ana@example..com", "what was typed stays in the field");
  assert.equal(after.props!["aria-invalid"], true);
  const alert = find(view.tree(), (n: El) => n.props?.role === "alert")[0] as El;
  assert.ok(alert, "the problem is said as an alert");
  assert.equal(alert.props!.tabIndex, -1, "and it can take the focus");
  assert.match(String(after.props!["aria-describedby"]), new RegExp(String(alert.props!.id)));
  // Fixed, it is sent.
  (byId(view.tree(), "dnc-contact")!.props!.onChange as (e: unknown) => void)({ currentTarget: { value: "ana@example.com" }, target: { value: "ana@example.com" } });
  await view.settle();
  prevented = false;
  (find(view.tree(), (n: El) => n.type === "form")[0].props!.onSubmit as (e: unknown) => void)({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  // Confirmation before an entry the page cannot take back.
  const confirm = byId(view.tree(), "dnc-confirm")!;
  assert.equal(confirm.props!.type, "checkbox");
  assert.equal(confirm.props!.name, "confirm");
  assert.equal(confirm.props!.value, "yes");
  assert.equal(confirm.props!.required, true);
  assert.match(texts(view.tree()).join(" "), /stays on our list/i);
  // The field for bots is not one a browser fills in by itself.
  const trap = find(view.tree(), (n: El) => n.props?.tabIndex === -1 && n.type === "input")[0] as El;
  assert.ok(trap);
  assert.notEqual(trap.props!.name, "website");
  assert.equal(trap.props!.autoComplete, "off");
  view.unmount();
});

test("a notice sent back by the server can take the focus, and the operator's form posts to the operator's route", async () => {
  for (const status of ["contact", "limited", "full", "error", "confirm"]) {
    const view = await mount(DoNotContactForm, { status, operator: false });
    const alert = find(view.tree(), (n: El) => n.props?.role === "alert")[0] as El;
    assert.ok(alert, status);
    assert.equal(alert.props!.tabIndex, -1, status);
    view.unmount();
  }
  const done = await mount(DoNotContactForm, { status: "done", operator: false });
  assert.equal((find(done.tree(), (n: El) => n.props?.role === "status")[0] as El).props!.tabIndex, -1);
  const full = await mount(DoNotContactForm, { status: "full", operator: false });
  assert.match(texts(full.tree()).join(" "), /If you asked us before, you are still on our list/);
  const operator = await mount(DoNotContactForm, { status: "", operator: true });
  assert.equal((find(operator.tree(), (n: El) => n.type === "form")[0] as El).props!.action, "/api/operator/do-not-contact");
});

test("the page shows the operator's form only to the operator", async () => {
  redis.clear();
  const formOf = async (cookie: string) => {
    answering(new Request("https://marktmorgen.com/privacy/do-not-contact", { headers: cookie ? { cookie } : {} }));
    try {
      const tree = await DoNotContactPage({ searchParams: Promise.resolve({}) });
      const el = find(tree, (n: El) => n.type === DoNotContactForm)[0] as El;
      return el.props as { operator: boolean };
    } finally {
      answering(null);
    }
  };
  await withOperator(async () => {
    assert.equal((await formOf("")).operator, false);
    assert.equal((await formOf(`${SESSION_COOKIE}=${await openSession("stranger@example.test")}`)).operator, false);
    assert.equal((await formOf(`${SESSION_COOKIE}=${await openSession(OPERATOR)}`)).operator, true);
  });
});

test("the stand-in answers the script as a real Redis did, step for step", () => {
  // Run by hand against redis-server 7.0.15 on 9 November 2026 (redis-cli EVAL, the same keys and arguments: the
  // list's ceiling 4, the public form's 2 then 5, its day's 3 then 1):
  // 1 0 -1 0 1 1 1 -1, TTL 172800, public count "2", day "2", name "", HLEN 4; then 1 -2 -1, count "1", day "1";
  // a mode it does not know, or a count that is not a number, fails the script.
  redis.clear();
  const ev = (field: string, name: string, by: string, publicMost: number, perDay: number) =>
    redis.run(["EVAL", ADD_DO_NOT_CONTACT, "3", "L", "D", "P", field, name, by, "4", String(publicMost), String(perDay), "172800"]);
  assert.deepEqual(
    [
      ev("email:a", "", "public", 2, 3), ev("email:a", "x", "public", 2, 3), ev("email:b", "", "public", 2, 3), ev("email:a", "", "operator", 2, 3),
      ev("email:b", "", "operator", 2, 3), ev("email:c", "", "operator", 2, 3), ev("email:d", "", "operator", 2, 3), ev("email:e", "", "operator", 2, 3),
    ],
    [1, 0, -1, 0, 1, 1, 1, -1],
  );
  assert.equal(redis.run(["TTL", "D"]), 172_800);
  assert.deepEqual([redis.run(["GET", "P"]), redis.run(["GET", "D"]), redis.run(["HGET", "L", "email:a"]), redis.run(["HLEN", "L"])], ["2", "2", "", 4]);
  redis.run(["DEL", "L", "D", "P"]);
  assert.deepEqual([ev("email:x", "", "public", 5, 1), ev("email:y", "", "public", 5, 1), ev("email:z", "", "operator", 5, 1)], [1, -2, -1]);
  assert.deepEqual([redis.run(["GET", "P"]), redis.run(["GET", "D"])], ["1", "1"]);
  assert.throws(() => ev("email:q", "", "other", 5, 1));
  redis.run(["SET", "P", "abc"]);
  assert.throws(() => ev("email:q", "", "operator", 5, 1));
});
