/**
 * A refused call to another service says why (534 [FQ1], unit 33; added 2
 * November 2026). withinService answers only yes or no; withinServiceWhy
 * (lib/metered-limits.ts) says which: the short window ("tries"), or the
 * store's figure for calls to connected services with its own words (used,
 * in the trial's own window or the month's; no place this month; not counted
 * just now). Routes that answer in JSON send those words as `message`;
 * routes that send the creator back to a page send "allowance-<reason>",
 * which the page words with serviceAllowanceWords. A paid period whose
 * resources could not be reserved is "funding", never "too many tries"; the
 * Zoom host link refused here is never called Zoom's; and an outreach read
 * refused for the day takes nothing from the month.
 */
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { serviceRefusalCode, serviceRefusedJson, withinServiceWhy } from "@/lib/metered-limits";
import { serviceAllowanceWords } from "@/lib/store-allowance";
import { NON_PAYING_ALLOWANCES } from "@/lib/store-allowance-rules";
import { POOL_FULL_WORDS } from "@/lib/free-pool-rules";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const DAY = 86_400_000;
const now = Date.now();
const trial = { sid: "t".repeat(32), handle: "trialstore", statsId: "stats_trial", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_Trial0001", trialEnds: (now + 5 * DAY) / 1000, planEndedAt: "", cycle: "month" as const };

async function main() {
  part("Why, said as it is");
  redis.clear();
  is("the short window: tries", [await withinServiceWhy("test-scope", "who", 1, 60, trial as never), await withinServiceWhy("test-scope", "who", 1, 60, trial as never)], [null, { reason: "tries" }]);
  for (let i = 0; i < NON_PAYING_ALLOWANCES.trial.integration; i++) await withinServiceWhy(`fill-${i}`, "who", 5, 60, trial as never);
  const used = await withinServiceWhy("one-more", "who", 5, 60, trial as never);
  is("the trial's figure used: its own words, for this trial", [used?.reason, used && "message" in used && used.message.includes("for this trial are used")], ["used", true]);
  is("the JSON answer carries the words; a page's code names the reason", [used ? JSON.stringify(await serviceRefusedJson(used, "slow").json()) : "", used ? serviceRefusalCode(used, "limited") : "", serviceRefusalCode({ reason: "tries" }, "limited"), JSON.stringify(await serviceRefusedJson({ reason: "tries" }, "slow").json())], [JSON.stringify({ ok: false, error: "slow", message: used && "message" in used ? used.message : "" }), "allowance-used", "limited", JSON.stringify({ ok: false, error: "slow" })]);
  is("the page's words for each code", [serviceAllowanceWords(trial as never, "allowance-used")?.includes("for this trial are used"), serviceAllowanceWords(trial as never, "allowance-pool"), serviceAllowanceWords(trial as never, "allowance-unknown"), serviceAllowanceWords(trial as never, "limited")], [true, POOL_FULL_WORDS, "This can't be counted right now. Try again in a minute.", null]);
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => String(c[1] ?? "").startsWith("nl:free:in:"))) throw new Error("the database did not answer");
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const unknown = await withinServiceWhy("down", "who", 5, 60, { ...trial, sid: "u".repeat(32), statsId: "stats_down" } as never);
  redis.pipeline = pipeline;
  is("a database that does not answer: unknown, never tries", unknown?.reason, "unknown");

  part("The routes");
  const routes = ["app/api/store/paypal/connect/route.ts", "lib/meta-routes.ts", "app/api/store/discord/connect/route.ts", "lib/meet-routes.ts", "app/api/integrations/zoom/host/route.ts", "app/api/store/host-calendar/route.ts", "app/api/integrations/meetings/route.ts", "app/api/store/mail/picture/route.ts", "app/api/store/outreach/route.ts", "app/api/store/affiliates/paypal/route.ts", "app/api/store/person/route.ts", "app/api/store/email-sync/route.ts", "app/api/store/vault/route.ts", "app/api/store/stream/route.ts", "app/api/store/stream/captions/route.ts"];
  is("each creator-facing route says why, with withinServiceWhy", routes.filter((f) => !read(f).includes("withinServiceWhy(") || /\bwithinService\(/.test(read(f))), []);
  const funded = ["lib/meta-routes.ts", "app/api/store/discord/connect/route.ts", "app/api/discord/callback/route.ts", "lib/meet-routes.ts"].map((f) => flat(read(f)));
  is("a paid period not reserved is funding, never too many tries", funded.map((t) => { const codes = [...t.matchAll(/reservePaidResourceWindow\(store\)\)?\) return back\(([^)]*)\)/g)].map((m) => m[1]); return codes.length > 0 && codes.every((code) => code.includes("funding")); }), [true, true, true, true]);
  is("the pages word funding and each allowance code", [read("app/studio/discord/page.tsx").includes("funding:"), read("app/studio/calendar/page.tsx").includes('case "funding":'), read("app/studio/meetings/page.tsx").includes('case "funding":'), read("app/studio/page.tsx").includes("funding: {"), ["app/studio/discord/page.tsx", "app/studio/calendar/page.tsx", "app/studio/meetings/page.tsx", "app/studio/page.tsx"].every((f) => read(f).includes("serviceAllowanceWords(store,"))], [true, true, true, true, true]);
  is("the Zoom host link refused here is not called Zoom's", read("app/api/integrations/zoom/host/route.ts").includes('`meet=${serviceRefusalCode(refused, "limited")}&p=zoom`'), true);
  const outreach = flat(read("app/api/store/outreach/route.ts"));
  is("outreach: the day's limit before the month's figure, under its own words", [outreach.indexOf('withinLimit("outreach-find-day"') < outreach.indexOf('withinServiceWhy("outreach-find"'), outreach.includes('return fail("day", 429)'), read("components/outreach-studio.tsx").includes("day: \"That is today's limit of site reads. Try again tomorrow.\"")], [true, true, true]);

  part("The components show the server's words where it gave them");
  is("each one", ["components/mail-picture-button.tsx", "components/outreach-studio.tsx", "components/paypal-payouts.tsx", "components/person-find.tsx", "components/host-calendar.tsx", "components/meeting-connections.tsx", "components/email-sync-editor.tsx"].filter((f) => !/data\.message|answer\.message|\.message === "string"/.test(read(f))), []);
  is("uploads claim no reason they cannot know", [read("lib/studio-messages.ts").includes('slow_down: "Uploads can\'t start just now. Try again later."'), /hour's upload allowance|lot of videos in one hour/.test(read("lib/studio-messages.ts") + read("components/course-editor.tsx"))], [true, false]);

  done();
}

void main();
