import { chatMessagesOf } from "@/lib/community-chat";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COMMUNITY = "c".repeat(32);
const MEMBER = "a".repeat(32);
const OTHER = "b".repeat(32);
const original = redis.pipeline.bind(redis);

async function read(row: string): Promise<{ ok: boolean; value?: unknown }> {
  redis.pipeline = (async () => [[row]]) as typeof redis.pipeline;
  try {
    return { ok: true, value: await chatMessagesOf(COMMUNITY, MEMBER) };
  } catch {
    return { ok: false };
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  part("Ordinary unambiguous controls");
  is(
    "an exact own row is copied",
    await read(JSON.stringify({ i: 1, a: MEMBER, text: "Mine", at: 123 })),
    { ok: true, value: [{ text: "Mine", at: 123 }] },
  );
  is(
    "an exact other row is omitted",
    await read(JSON.stringify({ i: 2, a: OTHER, text: "Theirs", at: 124 })),
    { ok: true, value: [] },
  );

  part("Conflicting duplicate authors cannot prove whose words they are");
  is(
    "other then member remains unknown instead of being exported",
    await read(`{"i":3,"a":"${OTHER}","a":"${MEMBER}","text":"Ambiguous","at":125}`),
    { ok: false },
  );
  is(
    "member then other remains unknown instead of being omitted",
    await read(`{"i":4,"a":"${MEMBER}","a":"${OTHER}","text":"Ambiguous","at":126}`),
    { ok: false },
  );

  done();
}

void main();
