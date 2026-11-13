/**
 * Issue #4459 (Codex L, reproduced by Claude 2): a form submission reads and checks the respondent's address, then
 * pauses before its response is kept; that person's erasure completes in between. The late write must not bring the
 * answers back, and gives back the room it took. A response sent after the erasure, by the person's own new choice,
 * and anybody else's, are kept as before. Synthetic records; the public route is called as a browser would.
 */
import { NextRequest } from "next/server";
import { parseForm } from "@/lib/forms";
import { readResponses, writeForm } from "@/lib/form-store";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSitePages, storeForEmail } from "@/lib/store";
import { erasePerson } from "@/lib/person-erasure";
import { dataUsed } from "@/lib/store-data";
import { POST as submitForm } from "@/app/api/store/form/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const form = parseForm({ id: "formlate01", name: "Questions", fields: [{ id: "email1", type: "email", label: "Email", required: true }, { id: "detail", type: "long", label: "Question", required: true }], offerList: false })!;
  const owner = "formlate@example.com";
  await claimHandle(owner, "formlateshop", "Form Late", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setSitePages(owner, [{ id: "pagelate01", slug: "ask", title: "Ask", nav: false, target: "", from: 0 }]);
  const store = (await storeForEmail(owner))!;
  await writeForm(store.statsId!, form);
  const post = (email: string) =>
    submitForm(new NextRequest("https://marktmorgen.com/api/store/form", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `203.0.113.${email.length}` },
      body: new URLSearchParams({ handle: store.handle, form: form.id, page: "pagelate01", q_email1: email, q_detail: "When does it start?" }).toString(),
    }));
  const theirs = async (email: string) => (await readResponses(store.statsId, form.id)).responses.filter((r) => JSON.stringify(r).includes(email)).length;
  const used = async () => (await dataUsed(store))?.used ?? -1;

  part("A response let in before an erasure, written after it, brings nothing back (issue #4459)");
  const before = await used();
  const real = redis.pipeline.bind(redis);
  let release: () => void = () => {};
  const gate = new Promise<void>((open) => { release = open; });
  let paused: () => void = () => {};
  const reached = new Promise<void>((open) => { paused = open; });
  let held = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!held && commands[0]?.[0] === "EVAL" && String(commands[0]?.[1] ?? "").includes("marktmorgen:form-keep")) {
      held = true;
      paused();
      await gate;
    }
    return real(commands);
  }) as typeof redis.pipeline;
  const late = post("late@example.com");
  await reached;
  const erased = await erasePerson(store, "late@example.com", { kind: "person" });
  is("control: the erasure completes", erased.ok, true);
  release();
  const answered = await late;
  redis.pipeline = real;
  is("no answer from the erased respondent is kept after the erasure", await theirs("late@example.com"), 0);
  is("they are told it did not go through", (answered.headers.get("location") ?? "").includes("error"), true);
  is("the room the response took comes back", await used(), before);

  part("Sent again after the erasure, by their own new choice, it is kept as any other");
  await post("late@example.com");
  is("kept", await theirs("late@example.com"), 1);

  part("Anybody else is kept as before");
  await post("other@example.com");
  is("control: a second respondent can still submit", await theirs("other@example.com"), 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
