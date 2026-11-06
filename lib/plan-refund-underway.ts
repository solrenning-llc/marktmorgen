/**
 * Whether a plan refund the creator asked for is still being settled (305
 * [SY1]): a request is running (its lock is held) or a note says a refund
 * may have been made and is not decided yet (lib/plan-refund-flow.ts writes
 * the note before any money moves and the daily job decides it). Read by the
 * review page, which then shows no new confirmation, and by the route, which
 * then never says "Nothing was refunded". Throws when the store cannot be
 * read: the caller treats that as underway, never as settled.
 */
import { redisPipeline } from "@/lib/redis";
import { ENDING_KEY, flowKeyOf } from "@/lib/plan-refund-flow";
import { UnknownReplyError } from "@/lib/redis-reply";

function exactBinaryPair(reply: unknown): readonly [0 | 1, 0 | 1] {
  if (!Array.isArray(reply) || Object.getPrototypeOf(reply) !== Array.prototype) {
    throw new UnknownReplyError("the state of a plan refund");
  }
  const keys = Reflect.ownKeys(reply);
  const length = Object.getOwnPropertyDescriptor(reply, "length");
  const first = Object.getOwnPropertyDescriptor(reply, "0");
  const second = Object.getOwnPropertyDescriptor(reply, "1");
  const binary = (slot: PropertyDescriptor | undefined): slot is PropertyDescriptor & { value: 0 | 1 } =>
    !!slot && "value" in slot && (slot.value === 0 || slot.value === 1);
  if (
    keys.length !== 3 || keys[0] !== "0" || keys[1] !== "1" || keys[2] !== "length" ||
    !length || !("value" in length) || length.value !== 2 || !binary(first) || !binary(second)
  ) {
    throw new UnknownReplyError("the state of a plan refund");
  }
  return [first.value, second.value];
}

export async function refundUnderway(sid: string): Promise<boolean> {
  const [noted, running] = exactBinaryPair(await redisPipeline([
    ["HEXISTS", ENDING_KEY, sid],
    ["EXISTS", flowKeyOf(sid)],
  ]));
  return noted === 1 || running === 1;
}
