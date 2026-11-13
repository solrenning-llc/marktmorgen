/**
 * Defect #4407 (Codex X4): a deal's "Request payment" link put the buyer's email, the deal's text and its amount in
 * the URL, where they stay in the browser's history and in request logs. The link now carries only the deal's opaque
 * id (`deal=`), and the payment requests page reads that deal on the server (lib/deal-request-prefill.ts) to fill the
 * form in, for a role that may send them, never from what the URL says. Synthetic records only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DealsBoard } from "@/components/deals-board";
import { DEFAULT_STAGES, FIRST_PIPELINE_ID, type Deal, type Pipeline } from "@/lib/crm-rules";
import { dealRequestPrefill } from "@/lib/deal-request-prefill";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const pipelines: Pipeline[] = [{ id: FIRST_PIPELINE_ID, name: "Sales", stages: DEFAULT_STAGES }];
const deal: Deal = { id: "d000000001", title: "Synthetic coaching", email: "person@example.test", cents: 12500, stage: "lead00", note: "", createdAt: 100, updatedAt: 200 };

async function main(): Promise<void> {
  part("Codex X4's reproduction: the Request payment link");
  const html = renderToStaticMarkup(createElement(DealsBoard, { deals: [deal], stages: DEFAULT_STAGES, pipelines, pipelineMax: 5, fields: [], currency: "usd", assignees: ["owner@example.com"], today: "2026-10-17", requestHref: "/studio/requests?store=s1" }));
  const link = html.match(/<a[^>]*href="([^"]*)"[^>]*>(?:(?!<\/a>).)*Request payment/s)?.[1]?.replace(/&amp;/g, "&") ?? "";
  const url = decodeURIComponent(link.replace(/\+/g, " "));
  is("control: the link was found and points to the payment requests page", link.startsWith("/studio/requests?store=s1"), true);
  is("the buyer's email is not in the URL", url.includes("person@example.test"), false);
  is("the deal's text is not in the URL", url.includes("Synthetic coaching"), false);
  is("the amount is not in the URL", /125(\.00)?\b/.test(url), false);
  is("it names the deal by its opaque id only", link, "/studio/requests?store=s1&deal=d000000001");

  part("The page fills the form in from the deal read on the server");
  redis.clear();
  const statsId = "abcdef0124";
  await redis.pipeline([["HSET", `nl:crm:deals:${statsId}`, deal.id, JSON.stringify(deal)]]);
  is("the owner: the deal's person, text and amount", await dealRequestPrefill(statsId, "owner", deal.id), { email: "person@example.test", text: "Synthetic coaching", cents: 12500 });
  is("an admin too", (await dealRequestPrefill(statsId, "admin", deal.id))?.email, "person@example.test");
  is("a role that may not send requests: nothing", await dealRequestPrefill(statsId, "support", deal.id), null);
  is("an id that is not one: nothing", await dealRequestPrefill(statsId, "owner", "../x"), null);
  is("a deal that is not there: nothing", await dealRequestPrefill(statsId, "owner", "d000000009"), null);
  await redis.pipeline([["HSET", `nl:crm:deals:${statsId}`, "d000000002", JSON.stringify({ ...deal, id: "d000000002", email: "" })]]);
  is("a deal with no person: nothing", await dealRequestPrefill(statsId, "owner", "d000000002"), null);
  is("no store: nothing", await dealRequestPrefill(null, "owner", deal.id), null);
  done();
}

void main();
