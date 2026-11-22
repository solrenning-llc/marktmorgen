/**
 * A form's answers sent to POST /api/store/form are one of the store's public requests (`form-ip`, the
 * `public-requests` line of tests/plan-cost-registry.ts, priced as a later page: laterPageCost() in
 * tests/traffic-cost.ts). Claude 6 UoHAG on #2857 @400be93d04 (LEVE, cost): the write-ahead hold of lib/form-store.ts
 * addResponse runs more store-data scripts on every keep at the response limit (measured: two, the hold and the settle
 * that gives back the oldest's share; none before #2857's fix), and nothing measured the route's Redis commands
 * against what that line prices. Measured here as the embed card is (tests/embed-card-metered.test.ts):
 * every command the route sends, at the response limit (KEPT_RESPONSES), with the hold, the keep and its settle,
 * against COMMANDS.laterPage + COMMANDS.laterCount.
 *
 * Not in this count, and not changed by #2857: a funnel step's reads and count (lib/page-funnel-store.ts funnelHere,
 * countFunnelDone) and the sequences a form starts (lib/flows.ts enroll, here only its flow-list read); the box that
 * asks to join the list takes its own `join-ip` request (lib/store-join.ts). Synthetic store; MemoryRedis.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, setSitePages, setSubscription, storeForEmail } from "@/lib/store";
import { KEEP_FORM_RESPONSE, writeForm } from "@/lib/form-store";
import { KEPT_RESPONSES, parseForm, type FormResponse } from "@/lib/forms";
import { noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { POST as sendForm } from "@/app/api/store/form/route";
import { COMMANDS } from "./traffic-cost";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "form-metered@example.test";
  await claimHandle(OWNER, "formmeter", "Form Meter", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_FormMeter001", subscriptionId: "sub_FormMeter001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setSitePages(OWNER, [{ id: "pagepage01", slug: "apply", title: "Apply", nav: false, target: "", from: 0 }]);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const answer = (email: string, at: number): FormResponse => ({ at, page: "pagepage01", answers: { email1: email }, outcome: "", joined: false });
  const ceiling = COMMANDS.laterPage + COMMANDS.laterCount;

  // A form holding `held` responses, noted in the store's data room as the store keeps them.
  const formWith = async (id: string, held: number) => {
    const form = parseForm({ id, name: "Apply", fields: [{ id: "email1", type: "email", label: "Email", required: true }], offerList: false })!;
    await writeForm(statsId, form);
    if (held) {
      const rows = Array.from({ length: held }, (_, i) => JSON.stringify(answer(`${id}${i}@example.com`, held - i)));
      await real([["RPUSH", `nl:form:r:${statsId}:${id}`, ...rows]]);
      await noteData(store, [{ slot: `fr:${id}`, bytes: rows.reduce((sum, raw) => sum + dataBytes([raw], 1), 0) }]);
    }
    return form;
  };
  // Every command one submission sends, as the route sends it.
  const submit = async (formId: string, email: string) => {
    const log: Command[] = [];
    redis.pipeline = (async (batch: Command[]) => {
      log.push(...batch);
      return real(batch);
    }) as typeof redis.pipeline;
    try {
      const response = await sendForm(
        new NextRequest("https://marktmorgen.com/api/store/form", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" },
          body: new URLSearchParams([["handle", "formmeter"], ["form", formId], ["page", "pagepage01"], ["q_email1", email]]),
        }),
      );
      return { log, location: response.headers.get("location") ?? "" };
    } finally {
      redis.pipeline = real as typeof redis.pipeline;
    }
  };
  const scripts = (log: Command[], name: string) => log.filter((c) => c[0] === "EVAL" && String(c[1]).startsWith(`-- marktmorgen:${name}:`)).length;
  const listed = (log: Command[]) => log.map((c) => (c[0] === "EVAL" ? `EVAL ${String(c[1]).split("\n")[0].replace("-- marktmorgen:", "")}` : String(c[0]))).join(", ");

  part("At the response limit: the hold, the keep and its settle stay inside a later page's commands");
  const full = await formWith("meterfull1", KEPT_RESPONSES);
  const atLimit = await submit(full.id, "new@example.com");
  is("the answers were kept (on to the thank-you)", atLimit.location, `https://marktmorgen.com/@formmeter/form/${full.id}?p=pagepage01`);
  is("the keep ran once", atLimit.log.filter((c) => c[0] === "EVAL" && c[1] === KEEP_FORM_RESPONSE).length, 1);
  is(`at most ${ceiling} commands (${atLimit.log.length}: ${listed(atLimit.log)})`, atLimit.log.length <= ceiling, true);

  part("Below the limit, the same submission without the write-ahead hold");
  const room = await formWith("meterroom1", 1);
  const below = await submit(room.id, "other@example.com");
  is(`at most ${ceiling} commands (${below.log.length}: ${listed(below.log)})`, below.log.length <= ceiling, true);
  is(
    "the limit adds two store-data scripts, the write-ahead hold and the settle that gives back the oldest's share, and nothing else",
    [scripts(atLimit.log, "store-data") - scripts(below.log, "store-data"), scripts(atLimit.log, "form-keep"), scripts(below.log, "form-keep")],
    [2, 1, 1],
  );
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
