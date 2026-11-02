/**
 * 612 [WP11], unit 2: a member held by the team's two-step rule is sent to
 * /studio/second-step, which offers a passkey and an authenticator app; a
 * member who owns a store of their own is taken there instead of being held,
 * unless they asked for the other store by name (lib/studio-route.ts,
 * app/studio/second-step/page.tsx). Synthetic records only.
 */
import { readFileSync } from "node:fs";
import { putMember, setRequireTwoStep } from "@/lib/team";
import { resolveAccess } from "@/lib/studio-route";
import { claimHandle, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "owner-page@example.com";
const HELPER = "helper-page@example.com";
const SELLER = "seller-page@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "two-step-page", "Two Step Page", "");
  const store = (await ensureStoreId((await storeForEmail(OWNER))!.email)) ?? (await storeForEmail(OWNER))!;
  await claimHandle(SELLER, "seller-own-shop", "Seller Own Shop", "");
  const own = (await ensureStoreId((await storeForEmail(SELLER))!.email)) ?? (await storeForEmail(SELLER))!;
  await putMember(store, HELPER, "editor");
  await putMember(store, SELLER, "editor");
  await setRequireTwoStep(store, true, OWNER);

  part("Held, and where to");
  const held = await resolveAccess(HELPER, { remembered: store.sid }, null);
  is("a member with no store of their own is held at the rule", held.ok ? "open" : [held.reason, held.store?.sid], ["two_step", store.sid]);
  const named = await resolveAccess(SELLER, { pinned: store.sid }, null);
  is("asked for by name, a member who owns a store is held too", named.ok ? "open" : named.reason, "two_step");
  const fell = await resolveAccess(SELLER, { remembered: store.sid }, null);
  is("not asked for by name, they are taken to their own store", fell.ok ? [fell.access.store.sid, fell.access.role] : fell.reason, [own.sid, "owner"]);

  part("The routes and pages send them to the setup page");
  const route = readFileSync("lib/studio-route.ts", "utf8");
  is("a form or link route", route.includes('if (result.reason === "two_step") return away(origin, `/studio/second-step?store=${result.store?.sid ?? ""}`);'), true);
  is("every studio page", route.includes('if (!result.ok && result.reason === "two_step" && result.store?.sid) redirect(`/studio/second-step?store=${result.store.sid}`);'), true);

  part("The setup page offers both ways, and shows nothing of the store but its name");
  const page = readFileSync("app/studio/second-step/page.tsx", "utf8");
  is("a passkey", page.includes("<PasskeyManager"), true);
  is("an authenticator app, with its recovery address", page.includes("<TwoStepManager") && page.includes("<RecoveryAddressManager"), true);
  is("says whose rule it is and that the role stays", page.includes("asks everyone on its team to sign in with a second step") && page.includes("your role stay as they were"), true);
  is("only for someone on that store's team", page.includes('if (!store || !role) redirect("/studio");'), true);
  is("one h1, then h2 sections", [(page.match(/<h1\b/g) ?? []).length, (page.match(/<h2\b/g) ?? []).length], [1, 2]);
  is("not indexed", page.includes("robots: { index: false, follow: false }"), true);

  done();
}

void main();
