/** #3988: real preview reader must reject a valid course record returned under a different course's key. */
import { emptyCourse, readCourse, saveCourse } from "@/lib/course";
import { readPageFacts } from "@/lib/page-facts-read";
import { FINISHED_FACT_READY } from "@/lib/sales-page";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is } from "./check";

async function main() {
  redis.clear();
  const a = { ...emptyCourse(), certificate: true };
  const b = { ...emptyCourse(), certificate: true };
  await saveCourse(a, ROOM);
  await saveCourse(b, ROOM);
  const [raw] = await redis.pipeline([["GET", `nl:course:${b.id}`]]);
  if (typeof raw !== "string") throw new Error("synthetic course record missing");
  await redis.pipeline([["SET", `nl:course:${a.id}`, raw]]);
  for (let i = 0; i < 12; i++) {
    const id = `cert${String(i).padStart(12, "0")}`;
    await redis.pipeline([
      ["SET", `nl:cert:${id}`, JSON.stringify({ id, store: "synthetic-b", productId: "p", courseId: b.id, name: "Learner", title: "Course B", creator: "Creator", email: `learner${i}@example.com`, issuedAt: 1, withdrawnAt: 0 })],
      ["HSET", `nl:course:${b.id}:certs`, `learner${i}`, id],
    ]);
  }
  is("control: the tolerant reader accepts the structurally valid but mismatched record", (await readCourse(a.id))?.id, b.id);
  const real = redis.pipeline.bind(redis);
  const counts: string[] = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const command of commands) if (command[0] === "HLEN") counts.push(String(command[1]));
    return real(commands);
  }) as typeof redis.pipeline;
  const store = { statsId: "synthetic-a", language: "en", look: { sold: false } } as unknown as Store;
  const product = { id: "p", course: { id: a.id, lessons: 1 }, bundle: null } as unknown as Listing;
  try {
    const result = await readPageFacts(store, product);
    // Off (FINISHED_FACT_READY false, Claude 6 review of #3988): nothing is read, so nothing is unread; once on, the
    // mismatched record is unread. Either way no certificate counter is queried.
    is("mismatched identity is unread once the count is on, and no certificate counter is queried", [result.facts.finished, result.factsUnread.includes("finished"), counts], [undefined, FINISHED_FACT_READY, []]);
  } finally { redis.pipeline = real; }
}
main().then(done, (error) => { console.error(error); process.exit(1); });
