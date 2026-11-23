/**
 * Issue #3964 (Codex G; security): a store's drafts (lib/catalog.ts, `hidden`) are shown at their public address
 * only to someone who may work on them (lib/draft-view.ts seesDrafts). It let in anyone on the team, whatever the
 * role, so a `support` member (orders, community and reviews only, lib/team-roles.ts) saw a hidden course's
 * outline, a draft call, a podcast page and a sample certificate, which the studio itself never shows them (the
 * products screen needs `products`). Now only the owner and a role with `products` (admin, editor) see drafts; a
 * support member is told what a stranger is. Their purchases still open through their own access, not here.
 *
 * Synthetic only: the in-memory Redis and a synthetic store.
 */
import { openSession } from "@/lib/auth";
import { seesDrafts } from "@/lib/draft-view";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const owner = "drafts-owner@example.com";
  if (!(await claimHandle(owner, "draftroles", "Draft roles", "")).ok) throw new Error("no store");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  const store = (await storeForEmail(owner))!;
  for (const [email, role] of [["admin@example.com", "admin"], ["editor@example.com", "editor"], ["support@example.com", "support"]] as const) {
    if (!(await putMember(store, email, role))) throw new Error(`no ${role}`);
  }
  const fresh = (await storeForEmail(owner))!;

  part("Who may work on a draft sees it");
  is("the owner", await seesDrafts(fresh, await openSession(owner)), true);
  is("an admin (products)", await seesDrafts(fresh, await openSession("admin@example.com")), true);
  is("an editor (products)", await seesDrafts(fresh, await openSession("editor@example.com")), true);

  part("Who may not is told what a stranger is");
  is("a support member (no products)", await seesDrafts(fresh, await openSession("support@example.com")), false);
  is("a signed-in stranger", await seesDrafts(fresh, await openSession("stranger@example.com")), false);
  is("no session", await seesDrafts(fresh, undefined), false);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
