/**
 * 405 [HX1] unit 5: the studio's save of the numbers email to addresses
 * outside the team, the invitation it emails, and the screen. Synthetic
 * store, team and addresses on the in-memory database; the sender is a
 * stand-in that records what would have gone, so no real email is sent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { POST as saveRoute } from "@/app/api/store/report-guests/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStoreId, storeForEmail } from "@/lib/store";
import { readShare } from "@/lib/report-guests";
import { inviteMessage } from "@/lib/report-guests-mail";
import { guestStatus, shareView, INVITE_DAYS } from "@/lib/report-guests-rules";
import { takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { ReportGuestsPicker } from "@/components/report-guests-picker";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only"; // a synthetic credential the Resend fixture knows

const OWNER = "owner@example.test";
const DAY = 86_400_000;
const sent: { to: string; subject: string; text: string; headers: Record<string, string> }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body));
    for (const one of Array.isArray(body) ? body : [body]) sent.push({ to: [one.to].flat()[0], subject: one.subject, text: one.text, headers: one.headers ?? {} });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  throw new Error(`no network in this test: ${url.href}`);
}) as typeof fetch;

let cookie = "";
async function owner() {
  if (!cookie) {
    await claimHandle(OWNER, "ledgerhx", "Ledger Studio", "");
    await ensureStoreId(OWNER);
    cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  }
  return (await storeForEmail(OWNER))!;
}
async function save(body: unknown) {
  await owner();
  const response = await saveRoute(
    new NextRequest("https://marktmorgen.com/api/store/report-guests", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("saving sends each new address one invitation, counted on the store's emails, and says where each one is", async () => {
  const store = await owner();
  sent.length = 0;
  const first = await save({ figures: ["sales", "visits"], every: "week", addresses: ["partner@example.test", ""] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.guests, [{ address: "partner@example.test", status: "waiting" }]);
  assert.deepEqual(first.body.notSent, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "partner@example.test");
  assert.equal(sent[0].subject, "Ledger Studio wants to email you its numbers");
  assert.match(sent[0].text, /\/api\/numbers-guest\/confirm\?t=[A-Za-z0-9_-]{43}/);
  assert.match(sent[0].text, /\/api\/numbers-guest\/leave\?t=[A-Za-z0-9_-]{43}/);
  assert.match(sent[0].headers["List-Unsubscribe"], /^<https:\/\/.+\/api\/numbers-guest\/leave\?t=[A-Za-z0-9_-]{43}>$/);
  assert.equal(sent[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  // No figure of the store is in the invitation: only their names.
  assert.ok(sent[0].text.includes("- Sales\n- Visits"));

  // Saved again with the same address: no second invitation.
  const again = await save({ figures: ["sales"], every: "month", addresses: ["partner@example.test"] });
  assert.equal(again.status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual((await readShare(store.sid)).figures, ["sales"]);
});

test("a refused list changes nothing and sends nothing", async () => {
  await owner();
  sent.length = 0;
  const before = await readShare((await owner()).sid);
  for (const [body, error] of [
    [{ figures: ["sales"], every: "week", addresses: [OWNER] }, "own_address"],
    [{ figures: ["sales"], every: "week", addresses: ["a@example.test", "b@example.test", "c@example.test", "d@example.test"] }, "too_many"],
    [{ figures: ["names"], every: "week", addresses: [] }, "invalid"],
    // Not offered yet: no reader holds it in full.
    [{ figures: ["subscribers"], every: "week", addresses: [] }, "invalid"],
    [{ figures: ["sales", "affiliates"], every: "week", addresses: [] }, "invalid"],
  ] as [unknown, string][]) {
    const refused = await save(body);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, error);
  }
  assert.equal(sent.length, 0);
  assert.deepEqual(await readShare((await owner()).sid), before);
});

test("when the store's emails are used up, the invitation is not sent and the answer says so", async () => {
  const store = await owner();
  sent.length = 0;
  const room = allowanceFor(store, "email");
  for (let i = 0; i < room; i += 1) {
    const taken = await takeAllowance(store, "email");
    if (!taken.ok) break;
  }
  const saved = await save({ figures: ["sales"], every: "month", addresses: ["partner@example.test", "books@example.test"] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.notSent, ["books@example.test"]);
  assert.equal(sent.length, 0, "nothing goes past the figure");
});

test("signed out, nothing is read or saved", async () => {
  const response = await saveRoute(new NextRequest("https://marktmorgen.com/api/store/report-guests", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(response.status, 401);
});

test("the invitation says who, what, how often, the two links and why it came", () => {
  const message = inviteMessage({ name: "", handle: "plainshop" }, "week", [], { confirmToken: "c".repeat(43), leaveToken: "l".repeat(43) });
  assert.equal(message.subject, "@plainshop wants to email you its numbers");
  assert.ok(message.text.includes("None picked yet. Nothing is sent until the store picks some."));
  assert.ok(message.text.includes(`within ${INVITE_DAYS} days`));
  assert.ok(message.text.includes("It does not add you to any mailing list."));
  assert.ok(message.text.split("\n").every((line) => line.length <= 160 || line.includes("http")), "no line runs on");
});

test("each address's state is said in words", () => {
  const now = Date.UTC(2026, 10, 16);
  const at = (state: "invited" | "confirmed" | "left", ago: number) => ({ address: "a@example.test", state, invitedAt: now - ago });
  assert.equal(guestStatus(at("invited", DAY), now), "waiting");
  assert.equal(guestStatus(at("invited", (INVITE_DAYS + 1) * DAY), now), "ended");
  assert.equal(guestStatus(at("confirmed", 99 * DAY), now), "getting");
  assert.equal(guestStatus(at("left", DAY), now), "stopped");
  const view = shareView({ figures: [], every: "week", guests: [{ ...at("invited", DAY), confirm: "x", leave: "y" } as never] }, now);
  assert.deepEqual(view.guests, [{ address: "a@example.test", status: "waiting" }]);
  assert.ok(!JSON.stringify(view).includes('"x"'), "no link hash reaches the studio");
});

test("the screen: a labeled field for each choice, nothing picked by default, a live region, 44px targets", () => {
  const html = renderToStaticMarkup(createElement(ReportGuestsPicker, { initial: { figures: [], every: "week", guests: [{ address: "partner@example.test", status: "waiting" }] } }));
  assert.ok(html.includes("<h3"));
  assert.equal((html.match(/<fieldset/g) ?? []).length, 3);
  assert.equal((html.match(/<legend/g) ?? []).length, 3);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3, "only the figures a reader holds");
  assert.ok(!html.includes("New subscribers") && !html.includes("affiliates"));
  assert.ok(!/type="checkbox"[^>]*checked/.test(html), "no figure picked by default");
  assert.equal((html.match(/type="email"/g) ?? []).length, 3);
  for (const i of [0, 1, 2]) assert.match(html, new RegExp(`<label for="[^"]*-address-${i}"[^>]*>Address ${i + 1}</label>`));
  assert.ok(html.includes("Invited: waiting for a yes"));
  assert.ok(html.includes("Remove address 1"));
  assert.match(html, /role="status" aria-live="polite"/);
  assert.equal((html.match(/min-h-11/g) ?? []).length, 3 + 2 + 3, "every checkbox and radio label and every field");
  assert.ok((html.match(/btn-sm/g) ?? []).length >= 2, "the buttons are 44px tall (.btn-sm)");

  const unknown = renderToStaticMarkup(createElement(ReportGuestsPicker, { initial: "unknown" }));
  assert.ok(unknown.includes("could not be read just now"));
  assert.ok(!unknown.includes("<form"), "an unknown list is not shown as an empty one to save over");
});

test("the stand-in sender is the only one this test reaches", () => {
  assert.ok(!sent.some((one) => !one.to.endsWith("@example.test")));
  void redis;
});
