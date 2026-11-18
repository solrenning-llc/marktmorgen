/**
 * Codex G on #3017 @5b7a26d4 (MEDIUM, privacy): forgetServer reads the people (HKEYS, HVALS), then deletes them by id
 * (HDEL) with the address links of the rows it read. A join already under way could rewrite the same Discord id with
 * another address between the read and the delete (keepMember: the row, the NEW address's link, the due entry). The
 * HDEL by id removed the rewritten row, the DEL removed only the OLD address's link, HLEN said 0 and the server went:
 * the new address stayed linked to the Discord id for good, with no row and no server left to find it by, and a second
 * Disconnect answered "not connected". A person is now deleted only while their row is still the one read, in one step
 * with the delete; a rewritten one is kept, with its new link, so the disconnect says it did not finish and the next try
 * forgets them. Synthetic data, the memory Redis, no Discord call.
 */
import { emailKey } from "@/lib/learn";
import { accountOf, forgetServer, keepMember, membersOf, readServer, saveServer } from "@/lib/discord-store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ROOM = "rewriteroom";
const SID = "sid_rewrite";
const SERVER = "100000000000000041";
const U = "300000000000000041";
const OLD = "old@example.com";
const NEW = "new@example.com";

const real = redis.pipeline.bind(redis);

async function main(): Promise<void> {
  part("A person rewritten with another address while the server is being forgotten");
  redis.clear();
  await saveServer(ROOM, { id: SERVER, name: "The Club", at: 1, kick: false });
  await keepMember(ROOM, SID, U, { e: OLD, n: "U", p: [], r: [], at: 1, checked: 1 });
  // After the closer's HVALS, before its deletes: an already-started join keeps the same id with the new address.
  let rewrite = true;
  redis.pipeline = (async (sent: (string | number)[][]) => {
    const answers = await real(sent);
    if (rewrite && sent.length === 1 && sent[0][0] === "HVALS") {
      rewrite = false;
      await keepMember(ROOM, SID, U, { e: NEW, n: "U", p: [], r: [], at: 2, checked: 2 });
    }
    return answers;
  }) as typeof redis.pipeline;
  let thrown: unknown = null;
  try {
    await forgetServer(ROOM, SID);
  } catch (error) {
    thrown = error;
  }
  redis.pipeline = real;
  is("not forgotten: the rewritten person is still there, so forgetServer says it did not finish", thrown instanceof UnknownReplyError, true);
  is("the old address's link is gone; the new one is kept with its row and the server, for the next try", [await accountOf(ROOM, OLD), await accountOf(ROOM, NEW), (await membersOf(ROOM)).length, (await readServer(ROOM))?.id ?? null], [null, U, 1, SERVER]);
  is("the next try forgets them", await forgetServer(ROOM, SID).then((n) => n, () => "threw"), 1);
  is("and no address is left linked to the Discord id", [await accountOf(ROOM, OLD), await accountOf(ROOM, NEW), (await readServer(ROOM))?.id ?? null], [null, null, null]);
  is("its due entry is gone too", (await real([["ZSCORE", "nl:dc:due", `${SID}|${U}`]]))[0], null);
  is("(the new address's key, by name)", (await real([["EXISTS", `nl:dc:addr:${ROOM}:${emailKey(NEW)}`]]))[0], 0);
  done();
}

void main();
