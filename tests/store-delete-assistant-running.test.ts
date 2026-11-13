/**
 * Issue #4080 (Money defect, plan lifecycle): an extra store whose plan has
 * ended but whose Store assistant add-on is still running must not be deleted.
 * Once the store's address is released, nothing finds the add-on's
 * subscription again (lib/assistant-billing.ts applyListedAssistant reads the
 * store by its `assistant_for` handle), so it would keep charging every month
 * for a store that no longer exists. The add-on set to stop at the end of its
 * month, or already ended, charges nothing more, so the store can go.
 * Synthetic only: the in-memory Redis, no Stripe call.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, createStore, deleteStore, setAssistantPlan, storeForId, storeRef } from "@/lib/store";
import { POST as storesRoute } from "@/app/api/store/stores/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Math.floor(Date.now() / 1000);
const MONTH = { start: NOW - 86_400, end: NOW + 29 * 86_400, renews: true };

async function extraStore(owner: string, first: string, extra: string) {
  await claimHandle(owner, first, `${first} store`, "");
  const made = await createStore(owner, extra, `${extra} store`, "");
  if (!made.ok) throw new Error(`no extra store: ${JSON.stringify(made)}`);
  return made.store;
}

async function deleteFromStudio(owner: string, handle: string, sid: string) {
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const form = new FormData();
  form.set("action", "delete");
  form.set("confirm", handle);
  return storesRoute(new NextRequest("https://marktmorgen.com/api/store/stores", { method: "POST", headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie, "x-nimbus-store": sid }, body: form }));
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("An extra store with the Store assistant still renewing is not deleted");
  {
    const store = await extraStore("assist-run@example.com", "assistrunfirst", "assistrunextra");
    const ref = storeRef(store);
    const saved = await setAssistantPlan(ref, { subscriptionId: "sub_assistantrunning1", active: true, period: MONTH, cancelsAtEnd: false, disputedAt: "" });
    is("the add-on is written down as active and renewing", [saved?.assistantPlan?.active, saved?.assistantPlan?.cancelsAtEnd], [true, false]);
    is("the store's plan has ended", saved?.subscriptionActive ?? null, false);
    const result = await deleteStore(ref);
    is("deleting it is refused, by the add-on", result.ok ? "deleted" : result.reason, "assistant");
    is("the store is still there", (await storeForId(store.sid))?.handle ?? null, "assistrunextra");
  }

  part("From the studio: the owner is told why, and nothing is deleted");
  {
    const OWNER = "assist-studio@example.com";
    const store = await extraStore(OWNER, "assiststudiofirst", "assiststudioextra");
    await setAssistantPlan(storeRef(store), { subscriptionId: "sub_assistantrunning2", active: true, period: MONTH, cancelsAtEnd: false, disputedAt: "" });
    const response = await deleteFromStudio(OWNER, "assiststudioextra", store.sid);
    is("the route goes back to the studio with the add-on's notice", [response.status, response.headers.get("Location")?.includes("stores=assistant")], [303, true]);
    is("the store is still there", (await storeForId(store.sid))?.handle ?? null, "assiststudioextra");
    const page = readFileSync("app/studio/page.tsx", "utf8");
    is("the studio has a notice for that reason, saying how to stop the add-on", /\n\s+assistant: \{\n\s+title: "This store still has the Store assistant running",/.test(page), true);
    const button = "Stop at the end of this month";
    is("the button the notice names is the one the assistant's card shows", readFileSync("components/store-assistant-editor.tsx", "utf8").includes(`"${button}"`), true);
    is("and the notice names it", page.includes(`press \\u201c${button}\\u201d`), true);
  }

  part("An add-on set to stop at the end of its month charges nothing more: the store can go");
  {
    const store = await extraStore("assist-stop@example.com", "assiststopfirst", "assiststopextra");
    await setAssistantPlan(storeRef(store), { subscriptionId: "sub_assistantstopping", active: true, period: { ...MONTH, renews: false }, cancelsAtEnd: true, disputedAt: "" });
    const result = await deleteStore(storeRef(store));
    is("deleting it goes through", result.ok ? "deleted" : result.reason, "deleted");
  }

  part("An add-on that has ended does not hold the store");
  {
    const store = await extraStore("assist-ended@example.com", "assistendedfirst", "assistendedextra");
    await setAssistantPlan(storeRef(store), { subscriptionId: "sub_assistantended1", active: false, period: null, cancelsAtEnd: false, disputedAt: "" });
    const result = await deleteStore(storeRef(store));
    is("deleting it goes through", result.ok ? "deleted" : result.reason, "deleted");
  }

  part("An add-on whose payment did not go through can still renew: it holds the store until it is known to stop (Codex G and X5 on #4202)");
  {
    // As assistantPlanOf writes a past_due or unpaid subscription: not active, its period still running and renewing.
    const store = await extraStore("assist-due@example.com", "assistduefirst", "assistdueextra");
    await setAssistantPlan(storeRef(store), { subscriptionId: "sub_assistantpastdue1", active: false, period: MONTH, cancelsAtEnd: false, disputedAt: "" });
    const result = await deleteStore(storeRef(store));
    is("deleting it is refused, as an add-on not known to have stopped", result.ok ? "deleted" : result.reason, "assistant_due");
    is("the store is still there", (await storeForId(store.sid))?.handle ?? null, "assistdueextra");
    const page = readFileSync("app/studio/page.tsx", "utf8");
    const notice = /\n\s+assistant_due: \{\n\s+title: "([^"]+)",\n\s+body: "([^"]+)",/.exec(page);
    is("the studio has a notice for it", Boolean(notice), true);
    is("which names no button the assistant's card does not show while its payment is failing", /press|Stop at the end/i.test(notice?.[2] ?? "press"), false);
  }

  part("An add-on whose paid period is over charges nothing more: the store can go");
  {
    const store = await extraStore("assist-over@example.com", "assistoverfirst", "assistoverextra");
    await setAssistantPlan(storeRef(store), { subscriptionId: "sub_assistantover1", active: false, period: { start: NOW - 40 * 86_400, end: NOW - 10 * 86_400, renews: true }, cancelsAtEnd: false, disputedAt: "" });
    const result = await deleteStore(storeRef(store));
    is("deleting it goes through", result.ok ? "deleted" : result.reason, "deleted");
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
