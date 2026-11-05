/** Independent boundary checks for the corrective moderation target reader. */
import { readReportedTarget, ReportQueueReadError } from "@/lib/community";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

async function main() {
  const original = redis.pipeline.bind(redis), cm = "a".repeat(32);
  const post = "123456789abc", comment = "abcdef123456";
  const postValue = JSON.stringify({ id: post, a: "creator", title: "Confirmed post", text: "Post text", at: 1 });
  const commentValue = JSON.stringify({ id: comment, a: "creator", text: "Comment text", at: 1 });
  let postReply: unknown = [postValue], commentReply: unknown = [commentValue], getterReads = 0;
  let calls: (string | number)[][] = [];
  redis.pipeline = async commands => {
    calls.push(...commands);
    return (commands[0]?.[0] === "GET" ? postReply : commentReply) as never;
  };
  try {
    const target = { kind: "comment" as const, post, comment };
    is("a confirmed comment uses its confirmed parent", (await readReportedTarget(cm, target))?.comment?.id, comment);
    is("the exact existing two-command envelope is retained", calls, [["GET", `nl:cm:${cm}:p:${post}`], ["HGET", `nl:cm:${cm}:c:${post}`, comment]]);
    const malformed = [[], [undefined], [postValue, postValue], ["null"], ["{}"], [JSON.stringify({ id: "fedcba654321", a: "creator" })],
      Object.setPrototypeOf(new Array(1), [postValue]),
      Object.defineProperty(new Array(1), "0", { get() { getterReads++; return postValue; } })];
    for (const reply of malformed) {
      postReply = reply; commentReply = [commentValue]; calls = [];
      let rejected = false;
      try { await readReportedTarget(cm, target); } catch (error) { rejected = error instanceof ReportQueueReadError; }
      is("unknown parent evidence is refused", rejected, true);
      is("no comment read or retry follows an unknown parent", calls.map(command => command[0]), ["GET"]);
    }
    postReply = [postValue];
    for (const reply of [[], [undefined], [commentValue, commentValue], ["null"], ["{}"], [JSON.stringify({ id: post, a: "creator" })]]) {
      commentReply = reply; calls = [];
      let rejected = false;
      try { await readReportedTarget(cm, target); } catch (error) { rejected = error instanceof ReportQueueReadError; }
      is("unknown comment evidence is refused", rejected, true);
      is("an unknown comment adds no read or retry", calls.map(command => command[0]), ["GET", "HGET"]);
    }
    postReply = [null]; calls = [];
    is("an explicitly deleted parent can be omitted", await readReportedTarget(cm, target), null);
    is("a deleted parent does not read its comment", calls.map(command => command[0]), ["GET"]);
    postReply = [postValue]; commentReply = [null];
    is("an explicitly deleted comment can be omitted", await readReportedTarget(cm, target), null);
    is("an accessor was never executed as target evidence", getterReads, 0);
  } finally { redis.pipeline = original; }
  done();
}
void main();
