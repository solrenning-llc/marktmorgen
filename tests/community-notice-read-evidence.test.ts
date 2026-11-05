import { noticesFor, unreadCount, allNoticesOf } from "@/lib/community-notify";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const notice = { kind: "reply", post: "post001", comment: "comment001", by: "member001", words: "An answer", at: 200 };
const row = JSON.stringify(notice);
const rejects = async (read: () => Promise<unknown>) => {
  try { await read(); return false; } catch { return true; }
};

async function main() {
  const original = redis.pipeline;
  let calls = 0;
  let reply: unknown[] = [];
  redis.pipeline = async () => { calls += 1; return reply; };
  try {
    part("Confirmed empty and populated notification reads");
    reply = [[], null];
    is("confirmed empty list", await noticesFor("notice-proof", "member001"), { notices: [], unread: 0 });
    is("confirmed empty badge", await unreadCount("notice-proof", "member001"), 0);
    reply = [[]];
    is("confirmed empty data copy", await allNoticesOf("notice-proof", "member001"), []);
    reply = [[row], "100"];
    is("confirmed unread notice", await noticesFor("notice-proof", "member001"), { notices: [notice], unread: 1 });
    reply = [[row, "200"], "100"];
    is("confirmed badge", await unreadCount("notice-proof", "member001"), 1);
    reply = [[row]];
    is("confirmed data copy", await allNoticesOf("notice-proof", "member001"), [notice]);

    part("Unknown evidence cannot become an empty list or zero badge");
    for (const value of [[], [[], null, "extra"], [null, null], [[], false], [[], "invalid"]]) {
      reply = value;
      is("list rejects unknown envelope " + JSON.stringify(value), await rejects(() => noticesFor("notice-proof", "member001")), true);
      is("badge rejects unknown envelope " + JSON.stringify(value), await rejects(() => unreadCount("notice-proof", "member001")), true);
    }
    for (const value of [[], [null], [[], "extra"], [["{"]], [[row, "{"]]]) {
      reply = value;
      is("copy rejects incomplete evidence " + JSON.stringify(value), await rejects(() => allNoticesOf("notice-proof", "member001")), true);
    }
    reply = [[row, "invalid"], "100"];
    is("badge rejects invalid score", await rejects(() => unreadCount("notice-proof", "member001")), true);
    reply = [[row, "200", row], "100"];
    is("badge rejects odd score vector", await rejects(() => unreadCount("notice-proof", "member001")), true);
    const before = calls;
    reply = [];
    await rejects(() => noticesFor("notice-proof", "member001"));
    is("unknown read makes one pipeline call without retry", calls - before, 1);
  } finally { redis.pipeline = original; }
  done();
}
void main();
