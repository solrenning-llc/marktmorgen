import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { POST as publicPost } from "@/app/api/privacy/do-not-contact/route";
import { POST as operatorPost } from "@/app/api/operator/do-not-contact/route";
import { DoNotContactForm } from "@/components/do-not-contact-form";
import { SESSION_COOKIE } from "@/lib/auth";
import { DO_NOT_CONTACT_TRAP } from "@/lib/research-contact";
import {
  DO_NOT_CONTACT_DAY_PREFIX,
  DO_NOT_CONTACT_KEY,
  RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX,
  RESEARCH_STOP_NEW_PER_DAY,
  addToDoNotContact,
  mayContactForResearch,
  normalizeResearchContact,
} from "@/lib/research-do-not-contact";
import { openLockedSession } from "@/lib/two-step";
import { find, mount } from "./client-hooks";
import { store as redis } from "./redis-stub";

// The second pre-review of the research do-not-contact list (c42046db3f).
// Its proof is the base of these tests; its Q5 (a name typed by anyone for
// anyone's contact) is the owner's decision and is not here.

let net = 0;
function req(path: string, fields: Record<string, string>, headers: Record<string, string> = {}): NextRequest {
  net += 1;
  return new NextRequest(`https://marktmorgen.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://marktmorgen.com", host: "marktmorgen.com", "x-forwarded-for": `10.9.${Math.floor(net / 250)}.${net % 250}`, ...headers },
    body: new URLSearchParams(fields),
  });
}
const pub = (contact: string, extra: Record<string, string> = {}) => publicPost(req("/api/privacy/do-not-contact", { contact, name: "", confirm: "yes", ...extra }));
const status = (r: Response) => new URL(r.headers.get("location")!).searchParams.get("status");
const today = () => `${DO_NOT_CONTACT_DAY_PREFIX}${new Date().toISOString().slice(0, 10)}`;

async function probeDay(listed: boolean): Promise<string | null> {
  redis.clear();
  if (listed) await addToDoNotContact({ contact: "victim@example.com", name: "" });
  redis.run(["SET", today(), String(RESEARCH_STOP_NEW_PER_DAY - 1)]);
  assert.equal(status(await pub("victim@example.com")), "done");
  return status(await pub(`fresh${Math.random()}@example.com`));
}

test("the day's ceiling does not tell, through the next answer, whether a contact was listed", async () => {
  const whenListed = await probeDay(true);
  const whenNot = await probeDay(false);
  assert.equal(whenListed, whenNot, `listed -> next is ${whenListed}; not listed -> next is ${whenNot}`);
});

test("the public ceiling does not tell it either", async () => {
  const run = async (listed: boolean) => {
    redis.clear();
    for (let i = 0; i < RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX - 1; i += 1) redis.run(["HSET", DO_NOT_CONTACT_KEY, `email:f${i}@example.com`, ""]);
    redis.run(["HSET", DO_NOT_CONTACT_KEY, listed ? "email:victim@example.com" : "email:other@example.com", ""]);
    redis.run(["HDEL", DO_NOT_CONTACT_KEY, "email:f0@example.com"]);
    await pub("victim@example.com");
    return status(await pub(`fresh${Math.random()}@example.com`));
  };
  assert.equal(await run(true), await run(false));
});

test("one mailbox is one entry: +tags, Gmail's dots and googlemail.com", async () => {
  redis.clear();
  await addToDoNotContact({ contact: "johndoe@gmail.com", name: "" });
  for (const same of ["john.doe@gmail.com", "John.Doe+news@googlemail.com", "j.o.h.n.d.o.e@gmail.com"]) {
    assert.equal(await mayContactForResearch(same), false, same);
  }
  await addToDoNotContact({ contact: "ana@example.com", name: "" });
  assert.equal(await mayContactForResearch("ana+press@example.com"), false, "ana+press@ reaches ana@");
  assert.equal(await mayContactForResearch("a.na@example.com"), true, "dots count outside Gmail");
});

test("one profile is one entry: the sites' other names and every mobile or www prefix", () => {
  const same = (a: string, b: string) => assert.equal(normalizeResearchContact(a), normalizeResearchContact(b), `${a} / ${b}`);
  same("twitter.com/ana", "x.com/ana");
  same("mobile.twitter.com/ana", "x.com/ana");
  same("fb.com/ana", "facebook.com/ana");
  same("instagr.am/ana", "instagram.com/ana");
  same("www.m.instagram.com/ana", "instagram.com/ana");
  same("m.www.facebook.com/ana", "facebook.com/ana");
});

test("different people are never one entry: Facebook's numeric profiles and paths whose case matters", () => {
  const a = normalizeResearchContact("facebook.com/profile.php?id=100001");
  const b = normalizeResearchContact("facebook.com/profile.php?id=200002");
  assert.ok(a && b, "a numeric profile is kept");
  assert.notEqual(a, b);
  assert.equal(normalizeResearchContact("https://www.facebook.com/profile.php?id=100001&ref=x#y"), a, "only the id is kept");
  assert.equal(normalizeResearchContact("facebook.com/profile.php"), null, "no id, no profile");
  assert.notEqual(normalizeResearchContact("youtube.com/channel/UCabcDEF"), normalizeResearchContact("youtube.com/channel/UCABCdef"));
  assert.notEqual(normalizeResearchContact("anamakes.com/Shop"), normalizeResearchContact("anamakes.com/shop"));
  assert.equal(normalizeResearchContact("AnaMakes.COM/Shop"), "link:anamakes.com/Shop", "the host only is lowered");
});

test("the field for bots is answered as a plain failure, never as done", async () => {
  redis.clear();
  const said = status(await pub("real@example.com", { [DO_NOT_CONTACT_TRAP]: "x" }));
  assert.equal(said, "error");
  assert.equal(await mayContactForResearch("real@example.com"), true);
});

test("with no operator configured, the operator's route reads nothing", async () => {
  delete process.env.DEMO_STUDIO_ADMIN;
  let commands = 0;
  const original = redis.pipeline;
  redis.pipeline = (async (c) => {
    commands += c.length;
    return original.call(redis, c);
  }) as typeof redis.pipeline;
  try {
    const r = await operatorPost(req("/api/operator/do-not-contact", { contact: "a@example.com", confirm: "yes" }, { cookie: `${SESSION_COOKIE}=${"a".repeat(64)}` }));
    assert.equal(r.status, 404);
  } finally {
    redis.pipeline = original;
  }
  assert.equal(commands, 0);
});

test("a locked session of the operator does not reach the operator's route", async () => {
  redis.clear();
  const before = process.env.DEMO_STUDIO_ADMIN;
  process.env.DEMO_STUDIO_ADMIN = "operator@example.test";
  try {
    const locked = await openLockedSession("operator@example.test", Date.now() + 86_400_000);
    const r = await operatorPost(req("/api/operator/do-not-contact", { contact: "a@example.com", name: "", confirm: "yes" }, { cookie: `${SESSION_COOKIE}=${locked}` }));
    assert.equal(r.status, 404);
    assert.equal(await mayContactForResearch("a@example.com"), true);
  } finally {
    if (before === undefined) delete process.env.DEMO_STUDIO_ADMIN;
    else process.env.DEMO_STUDIO_ADMIN = before;
  }
});

type El = { type?: unknown; props?: Record<string, unknown> };

test("the confirmation box has a 44 by 44 target with its words inside, and is marked when it was missed", async () => {
  const view = await mount(DoNotContactForm, { status: "confirm", operator: false });
  const box = find(view.tree(), (n: El) => n.props?.id === "dnc-confirm")[0] as El;
  assert.equal(box.props!["aria-invalid"], true);
  assert.match(String(box.props!["aria-describedby"]), /dnc-status/);
  const label = find(view.tree(), (n: El) => n.type === "label" && n.props?.htmlFor === "dnc-confirm")[0] as El;
  assert.match(String(label.props!.className), /\bmin-h-11\b/);
  assert.equal(find(label, (n: El) => n.props?.id === "dnc-confirm").length, 1, "the box is inside its label");
  const plain = await mount(DoNotContactForm, { status: "", operator: false });
  assert.equal((find(plain.tree(), (n: El) => n.props?.id === "dnc-confirm")[0] as El).props!["aria-invalid"], undefined);
});

test("after the server says it could not save, what was typed is back in the form, from this tab only, never from the URL", async () => {
  const kept = new Map<string, string>();
  const tab = globalThis as unknown as { sessionStorage?: Storage };
  tab.sessionStorage = {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  } as Storage;
  try {
    const first = await mount(DoNotContactForm, { status: "", operator: false });
    const field = (tree: unknown, id: string) => find(tree, (n: El) => n.props?.id === id)[0] as El;
    (field(first.tree(), "dnc-contact").props!.onChange as (e: unknown) => void)({ currentTarget: { value: "ana@example.com" } });
    (field(first.tree(), "dnc-name").props!.onChange as (e: unknown) => void)({ currentTarget: { value: "Ana" } });
    await first.settle();
    (find(first.tree(), (n: El) => n.type === "form")[0].props!.onSubmit as (e: unknown) => void)({ preventDefault: () => {} });
    for (const said of ["error", "limited", "full", "confirm"]) {
      const back = await mount(DoNotContactForm, { status: said, operator: false });
      assert.equal(field(back.tree(), "dnc-contact").props!.value, "ana@example.com", said);
      assert.equal(field(back.tree(), "dnc-name").props!.value, "Ana", said);
    }
    await mount(DoNotContactForm, { status: "done", operator: false });
    assert.equal(kept.size, 0, "done forgets it");
  } finally {
    delete tab.sessionStorage;
  }
});
