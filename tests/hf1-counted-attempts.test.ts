/**
 * 663 [HF1]: a failure sentence never says nothing was counted when the attempt was counted (VR item 2). In lib/ai.ts
 * an AI attempt that started stays counted on purpose (the provider may bill it), and "failed" comes only after the
 * INCRBY, so the outreach email and the numbers question say the try counted. "busy" in outreach is refused before
 * the writing job (takeData), so it stays "Nothing was counted". A server error may come after the job started, so
 * it never says nothing was counted. And the texts the customer-voice summary sends drop a web address written
 * without http or www ("janesmith.dev"), by the same rule as the reviews summary (#1973, cleanReviewText).
 * Real component maps, real lib; no model call.
 */
import * as outreach from "@/components/outreach-studio";
import * as numbers from "@/components/numbers-ask";
import { cleanVoice } from "@/lib/customer-voice";
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const messagesOf = (module: unknown) => ((module as { MESSAGES?: Record<string, string> }).MESSAGES ?? {}) as Record<string, string>;
const NOTHING = /nothing was (counted|changed)/i;
const COUNTED = /counted as one of this month's/i;

part("Outreach: a failed email was counted");
const o = messagesOf(outreach);
is("failed says the try counted, never that nothing was", [NOTHING.test(o.failed ?? ""), COUNTED.test(o.failed ?? "")], [false, true]);
is("busy is refused before the job, and says so", /nothing was counted/i.test(o.busy ?? ""), true);
is("a server error never says nothing was counted or changed", [Boolean(o.server_error), NOTHING.test(o.server_error ?? "")], [true, false]);
is("the outreach route answers busy only before the writing job (takeData comes first)", (() => {
  const source = readFileSync("lib/outreach.ts", "utf8");
  return source.indexOf('reason: trace.reason === "full" ? "room" : "busy"') < source.indexOf("await writePitch(");
})(), true);

part("Numbers question: a failed answer was counted");
const n = messagesOf(numbers);
is("failed says the try counted, never that nothing was", [NOTHING.test(n.failed ?? ""), COUNTED.test(n.failed ?? "")], [false, true]);
is("a server error never says nothing was counted", [Boolean(n.server_error), NOTHING.test(n.server_error ?? "")], [true, false]);

part("Customer voice: a web address without http or www is a link too");
is("a bare domain and a domain with a path are taken out", cleanVoice("more at janesmith.dev and shop.example.com/sale today"), "more at [link] and [link] today");
is("prices, abbreviations and library names stay", cleanVoice("It was $3.50, e.g. for Node.js users"), "It was $3.50, e.g. for Node.js users");
is("the old cases stay", cleanVoice("Write to me at pat.smith@example.com or see https://example.com/x"), "Write to me at [email] or see [link]");

done();
