/** CX-121 orchestration/UI evidence. The imported fixture is explicitly an
 * ACK stand-in; real Lua/counter evidence lives in the companion Python test.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkShipped } from "@/components/mark-shipped";
import { enqueueShipmentMail, runShipmentMail, shipmentMailStatus } from "@/lib/shipment-mail-outbox";
import { shipmentOutboxFixture, shipmentPolicy } from "./shipment-mail-outbox-fixture";
import { store } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  const now = 1800000000000;
  const input = { statsId: "synthetic_release", session: "cs_test_shipmentrelease00001", authorizedAt: now,
    shipped: { at: now / 1000, tracking: "" }, message: { from: "Synthetic store <mail@example.test>", to: "buyer@example.test", subject: "Synthetic shipment", text: "Synthetic shipping update", replyTo: "owner@example.test" } };
  part("A confirmed provider refusal is terminal for protected message content");
  store.clear();
  const world = shipmentOutboxFixture();
  const runtime = { lifecycle: "active" as const, policy: shipmentPolicy(now), pipeline: world.pipeline, now: () => now };
  is("synthetic queue input was acknowledged", (await enqueueShipmentMail(input, runtime)).ok, true);
  const create = world.commands.find(command => command[0] === "EVAL")!;
  let posts = 0;
  await runShipmentMail(now + 20000, async (_message, beforePost) => { if (!await beforePost()) return "unknown"; posts++; return "refused"; }, runtime);
  is("the provider was attempted only once after its barrier", posts, 1);
  is("the refusal remains distinct from acceptance", (await shipmentMailStatus(input.statsId, input.session, runtime))?.state, "refused");
  const raw = store.run(["GET", String(create[3])]);
  is("a terminal refusal no longer retains the sealed message", typeof raw !== "string" || !JSON.parse(raw).sealed, true);
  is("a matching source starts its existing 400-day terminal retention", store.run(["TTL", String(create[4])]), 400 * 86400);
  await runShipmentMail(now + 20000, async () => { posts++; return "accepted"; }, runtime);
  is("a refusal is not automatically retried", posts, 1);

  part("The server-rendered mark must not invent missing mail evidence");
  const html = renderToStaticMarkup(createElement(MarkShipped, { session: input.session, to: null, shipped: input.shipped }));
  is("until a server status confirms it, missing acceptance is not asserted", html.includes("acceptance was not recorded"), false);
  const status = html.match(/<p\b[^>]*role="status"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
  is("the shipment status region excludes the email detail line", /acceptance|email/i.test(status), false);
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
