/** An unconfirmed course-event claim cannot start a real sequence. */
import { noteIfFinished, noteIfOpened } from "@/lib/course-finish";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { emailKey, markLesson } from "@/lib/learn";
import { upsertContact } from "@/lib/contacts";
import { readFlows, saveFlow } from "@/lib/flows";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

async function main() {
  const originalFetch = globalThis.fetch;
  let external = 0;
  globalThis.fetch = async () => { external++; throw Error("No external transport in this test"); };
  const original = redis.pipeline.bind(redis);
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args) => { errors.push(args); };
  try {
    redis.clear();
    const owner = "course-claims@example.com";
    await claimHandle(owner, "courseclaims", "Course claims", "");
    await ensureStatsId(owner);
    await ensureListId(owner);
    await setMailSettings(owner, { fromName: "Course claims", address: "Synthetic test address" });
    await setStripeAccount(owner, "acct_ClaimTest", true);
    await setSubscription(owner, { customerId: "cus_ClaimTest", subscriptionId: "sub_ClaimTest", active: true, tier: "pro", period: paidPeriod() });
    const made = await addProduct(owner, "Claim proof", "A synthetic course", "49", null);
    if (!made.ok) throw Error("Synthetic product was not created");
    // Use the actual module identity, as the editor does.
    const product = made.product;
    const base = emptyCourse();
    const built = editCourse(base, { op: "lesson-add", moduleId: base.modules[0].id, title: "Claim lesson" });
    if (!built.ok) throw Error("Synthetic lesson was not created");
    const course = built.course, lesson = course.modules[0].lessons[0].id;
    await saveCourse(course, ROOM);
    const linked = await setProductCourse(owner, product.id, { id: course.id, lessons: 1 });
    if (!linked.ok) throw Error("Synthetic course was not linked");
    const store = (await storeForEmail(owner))!;
    for (const trigger of ["started", "finished"] as const) {
      const flow = await saveFlow(store, { name: trigger, trigger, productId: product.id, active: true, steps: [{ delayHours: 0, subject: "Course event", body: "Synthetic sequence" }] }, { activate: true });
      if (!flow.ok) throw Error(`Synthetic ${trigger} flow was not created: ${JSON.stringify(flow)}`);
    }
    is("both real sequences are active", (await readFlows(store.listId)).map(flow => [flow.trigger, flow.active]).sort(), [["finished", true], ["started", true]]);
    let serial = 0, getterReads = 0;
    for (const kind of ["open", "fin"] as const) {
      part(`${kind}: only one exact OK can authorize enrollment`);
      const note = kind === "open" ? noteIfOpened : noteIfFinished;
      async function person() {
        const email = `learner${serial++}@example.com`;
        await upsertContact(store.listId!, email, { agreed: true, explicit: true, productId: product.id, title: product.title, source: "buyer" }, ROOM);
        if (kind === "fin") await markLesson(course.id, email, lesson, true, ROOM);
        return email;
      }
      const email = await person();
      is(`${kind}: an actual confirmed claim starts the event`, await note(store, product.id, course.id, email), true);
      const queued = await original([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]);
      is(`${kind}: the real enrollment queued one step for that student`, (queued[0] as string[]).filter(item => item.endsWith(`|${email}`)).length, 1);
      is(`${kind}: an ordinary repeated event does not start again`, await note(store, product.id, course.id, email), false);
      const variants: { name: string; reply: unknown; apply?: boolean; fail?: boolean; inheritedDescriptorValue?: boolean }[] = [
        { name: "missing reply", reply: [] }, { name: "missing slot", reply: [undefined] },
        { name: "false", reply: [false] }, { name: "zero", reply: [0] },
        { name: "integer", reply: [1] }, { name: "wrong string", reply: ["ok"] },
        { name: "extra reply", reply: ["OK", "OK"] }, { name: "object envelope", reply: { 0: "OK", length: 1 } },
        { name: "inherited slot", reply: Object.setPrototypeOf(new Array(1), ["OK"]) },
        { name: "getter slot", reply: Object.defineProperty(new Array(1), "0", { get() { getterReads++; return "OK"; } }) },
        {
          name: "getter slot with inherited descriptor value",
          reply: Object.defineProperty(new Array(1), "0", { get() { getterReads++; return "not-confirmed"; } }),
          inheritedDescriptorValue: true,
        },
        { name: "confirmed duplicate", reply: [null] },
        { name: "applied claim with lost reply", reply: [], apply: true },
        { name: "transport failure after applying", reply: [], apply: true, fail: true },
      ];
      for (const variant of variants) {
        const email = await person(), key = `nl:course:${course.id}:${kind}:${emailKey(email)}`;
        let claims = 0, readsAfterClaim = 0, queued = 0, seenClaim = false;
        redis.pipeline = async commands => {
          if (commands[0]?.[0] === "SET" && commands[0][1] === key) {
            claims++; seenClaim = true;
            if (variant.apply) await original(commands);
            if (variant.fail) throw Error("Synthetic lost claim response");
            if (variant.inheritedDescriptorValue) {
              Object.defineProperty(Object.prototype, "value", { value: "OK", configurable: true });
            }
            return variant.reply as never;
          }
          if (variant.inheritedDescriptorValue) Reflect.deleteProperty(Object.prototype, "value");
          if (seenClaim) readsAfterClaim += commands.length;
          queued += commands.filter(command => command[0] === "ZADD" && command[1] === "nl:mail:flowq").length;
          return original(commands);
        };
        const result = await note(store, product.id, course.id, email);
        if (variant.inheritedDescriptorValue) Reflect.deleteProperty(Object.prototype, "value");
        redis.pipeline = original;
        is(`${kind}/${variant.name}: no confirmed course event`, result, false);
        is(`${kind}/${variant.name}: one claim, no enrollment IO or queue`, [claims, readsAfterClaim, queued], [1, 0, 0]);
        if (variant.apply) is(`${kind}/${variant.name}: an applied unknown claim is retained`, await original([["GET", key]]), ["1"]);
      }

    }
    is("only the two injected transport failures were logged", errors.length, 2);
    is("a reply getter is never executed as confirmation", getterReads, 0);
    is("no provider or external transport was contacted", external, 0);
  } finally { redis.pipeline = original; globalThis.fetch = originalFetch; console.error = originalError; }
  done();
}
void main().catch(error => { console.error(error); process.exit(1); });
