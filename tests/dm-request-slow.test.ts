/**
 * Over the day's limit of openings, a new request is refused before anything
 * is written (lib/community-dm.ts send's mayAsk; Claude 6 on #3266). Before,
 * app/api/store/community/messages/route.ts wrote the request and only then
 * answered "slow" ("try again"), so the member sent it again and the request
 * held it twice. A follow-up to a request already waiting, and a message in a
 * conversation, go through as before: the cost of a stranger is in the opening.
 */
import { inbox, parseDmSetting, requestCount, send, thread } from "@/lib/community-dm";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const setting = parseDmSetting({ on: true, between: true, ask: true });

async function main(): Promise<void> {
  redis.clear();
  const id = "cmslow";

  part("A new request past the limit: refused, nothing written");
  {
    is("refused as slow", await send(id, setting, "ana", "bea", "hello", ROOM, { mayAsk: false }), { ok: false, reason: "slow" });
    is("no request waits", await requestCount(id, "bea"), 0);
    is("nothing in ana's own list", (await inbox(id, "ana")).length, 0);
    const [chat] = await redis.pipeline([["EXISTS", `nl:cm:${id}:dm:ana.bea`]]);
    is("no conversation stored", chat, 0);
  }

  part("Within the limit, and follow-ups past it, as before");
  {
    is("within the limit: a request", await send(id, setting, "ana", "bea", "hello", ROOM, { mayAsk: true }), { ok: true, asked: true });
    is("a follow-up past the limit still joins it", await send(id, setting, "ana", "bea", "again", ROOM, { mayAsk: false }), { ok: true, asked: true });
    is("one request, both messages", [await requestCount(id, "bea"), (await thread(id, "bea", "ana.bea"))?.messages.length], [1, 2]);
    is("no option: as before, a request", await send(id, setting, "cal", "bea", "hi", ROOM), { ok: true, asked: true });
    is("the creator past the limit goes through", await send(id, setting, "creator", "dan", "welcome", ROOM, { mayAsk: false }), { ok: true, asked: false });
  }

  done();
}

void main();
