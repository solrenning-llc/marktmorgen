/**
 * Pre-review probe (synthetic): one store's failure in the mail job's per-id loops stops every other store's send in
 * the run. advanceAnnouncements (lib/community-mail.ts) and, by rule 30, its twin advanceUpdates (lib/product-updates.ts)
 * now keep each id in its own try, as advanceAll (lib/broadcasts.ts) does: the failing one is logged and left for the
 * next run, its lock let go, and the others still move on.
 */
import { advanceAnnouncements } from "@/lib/community-mail";
import { advanceUpdates } from "@/lib/product-updates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main() {
  const a = "a".repeat(24), b = "b".repeat(24);
  const job = (id: string, handle: string) => JSON.stringify({ id, community: "c-" + handle, handle, post: "p", subject: "s", body: "b", total: 1, done: 0, sent: 0, status: "sending", note: "", failures: 0 });
  await redis.pipeline([["DEL", "nl:cm:mailq"], ["SET", "nl:cm:mail:" + a, job(a, "broken")], ["SET", "nl:cm:mail:" + b, job(b, "fine")], ["SADD", "nl:cm:mailq", a, b]]);
  const loaded: string[] = [];
  const load = async (handle: string) => { loaded.push(handle); if (handle === "broken") throw new Error("store read failed"); return null; };
  const logged = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    part("One store's error does not stop the others");
    let threw = false;
    try { await advanceAnnouncements(load, Date.now() + 5000); } catch { threw = true; }
    is("the run does not throw on one store's error", threw, false);
    is("the other store's send is still moved on", loaded.includes("fine"), true);
    is("the failure is logged, not hidden", errors.some(e => e.includes(a)), true);
    is("the failing send stays in line for the next run", (await redis.pipeline([["SISMEMBER", "nl:cm:mailq", a]]))[0], 1);
    is("its lock is let go", (await redis.pipeline([["GET", "nl:cm:mail:" + a + ":lock"]]))[0], null);

    part("Product updates (rule 30: the same loop)");
    const u = (id: string, handle: string) => JSON.stringify({ id, handle, statsId: "s-" + handle, product: "p", title: "t", words: "w", total: 1, done: 0, sent: 0, status: "sending", note: "", failures: 0, createdAt: 1 });
    await redis.pipeline([["DEL", "nl:updq"], ["SET", "nl:upd:job:" + a, u(a, "broken")], ["SET", "nl:upd:job:" + b, u(b, "fine")], ["SADD", "nl:updq", a, b]]);
    loaded.length = 0; errors.length = 0; threw = false;
    try { await advanceUpdates(load, Date.now() + 5000); } catch { threw = true; }
    is("the run does not throw on one store's error", threw, false);
    is("the other store's update is still moved on", loaded.includes("fine"), true);
    is("the failure is logged, not hidden", errors.some(e => e.includes(a)), true);
    is("the failing update stays in line for the next run", (await redis.pipeline([["SISMEMBER", "nl:updq", a]]))[0], 1);
    is("its lock is let go", (await redis.pipeline([["GET", "nl:upd:job:" + a + ":lock"]]))[0], null);
  } finally { console.error = logged; }
  done();
}
void main();
