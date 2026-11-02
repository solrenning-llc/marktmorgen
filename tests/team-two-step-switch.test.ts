/**
 * 612 [WP11], unit 3: the owner's switch (app/api/store/team/route.ts, action
 * "two-step"; components/team-two-step-switch.tsx; app/studio/team/page.tsx).
 * Only the owner may use it; only an owner with a second step may switch it
 * on; once on, a member without one is held; switching off frees them; the
 * switch is drawn for the owner with who is ready. Synthetic records only.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST as team } from "@/app/api/store/team/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { putMember, readTeam } from "@/lib/team";
import { resolveAccess } from "@/lib/studio-route";
import { claimHandle, ensureStoreId, storeForEmail } from "@/lib/store";
import { TeamTwoStepSwitch } from "@/components/team-two-step-switch";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const OWNER = "owner-switch@example.com";
const ADMIN = "admin-switch@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "team-switch", "Team Switch", "");
  const store = (await ensureStoreId((await storeForEmail(OWNER))!.email)) ?? (await storeForEmail(OWNER))!;
  await putMember(store, ADMIN, "admin");
  const [ownerSession, adminSession] = await Promise.all([openSession(OWNER), openSession(ADMIN)]);
  const send = async (session: string, on: boolean) => {
    const response = await team(new NextRequest(`https://marktmorgen.com/api/store/team?store=${store.sid}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: "https://marktmorgen.com", host: "marktmorgen.com" },
      body: JSON.stringify({ action: "two-step", on }),
    }));
    return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string; on?: boolean } };
  };

  part("Only the owner, and only with a second step of their own");
  const byAdmin = await send(adminSession, true);
  is("an admin cannot switch it", byAdmin.body.ok, false);
  is("an owner with no second step cannot switch it on", await send(ownerSession, true), { status: 409, body: { ok: false, error: "owner_two_step" } });
  is("so it stays off", (await readTeam(store.sid)).requireTwoStep, undefined);
  await redis.pipeline([["SET", `nl:pk:${sha(`nimbus-passkeys:${OWNER}`).slice(0, 40)}`, JSON.stringify([{ id: "c1", publicKey: "k1", counter: 0, transports: [], name: "Laptop", createdAt: "", lastUsedAt: "", synced: false }])]]);
  is("with a passkey, the owner switches it on", await send(ownerSession, true), { status: 200, body: { ok: true, on: true } });
  is("the team record says so", (await readTeam(store.sid)).requireTwoStep, true);

  part("On: a member without a second step is held; off: free again");
  const held = await resolveAccess(ADMIN, { pinned: store.sid }, null);
  is("held", held.ok ? "open" : held.reason, "two_step");
  is("switched off", (await send(ownerSession, false)).body, { ok: true, on: false });
  const free = await resolveAccess(ADMIN, { pinned: store.sid }, null);
  is("free again", free.ok ? "open" : free.reason, "open");

  part("Drawn for the owner, with who is ready");
  const html = renderToStaticMarkup(createElement(TeamTwoStepSwitch, { on: false, ownerReady: true, members: [{ email: ADMIN, ready: false }, { email: "editor-switch@example.com", ready: true }] }));
  is("a labeled checkbox", html.includes('type="checkbox"') && html.includes("Everyone on the team signs in with a second step"), true);
  is("described by its help", html.includes('aria-describedby="team-two-step-help"') && html.includes('id="team-two-step-help"'), true);
  is("who is ready, in words, not color", html.includes("has no second step yet") && html.includes("has a second step"), true);
  is("how many would be asked", html.includes("1 person would be asked to set one up."), true);
  const notReady = renderToStaticMarkup(createElement(TeamTwoStepSwitch, { on: false, ownerReady: false, members: [] }));
  is("an owner without one is told before trying", notReady.includes("You need a second step of your own before you can switch this on."), true);
  const page = readFileSync("app/studio/team/page.tsx", "utf8");
  is("the team page draws it for the owner only", page.includes("{owner ? (") && page.includes("<TeamTwoStepSwitch"), true);

  done();
}

void main();
