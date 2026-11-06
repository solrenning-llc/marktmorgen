/**
 * Sweep app-6 proof: components/community-push-toggle.tsx:118-139, turnOff.
 * The POST { action: "off" } is sent with `.catch(() => {})` and its answer is
 * never read; `subscription.unsubscribe()` is awaited with `.catch(() => {})`
 * and its boolean is never read. Whatever happened, the switch goes back to
 * "Turn notifications on" with no error. When both fail (the server answered
 * { ok: false } or could not be reached, and the browser kept the push
 * subscription), the device keeps getting notifications the member was just
 * shown as turned off.
 *
 * A check named "DEFECT" passes while the defect is present.
 */
import { CommunityPushToggle } from "@/components/community-push-toggle";
import { communityWords } from "@/lib/buyer-words/community";
import { find, mount, texts } from "./sweep-app6-hooks";
import { done, is, part } from "./check";

const t = communityWords("en").push;

async function pressOff(serverAnswer: () => Promise<Response>, browserUnsubscribes: () => Promise<boolean>) {
  const asked: unknown[] = [];
  let stillSubscribed = true;
  const subscription = {
    endpoint: "https://push.example.test/sweep",
    unsubscribe: async () => {
      const gone = await browserUnsubscribes();
      if (gone) stillSubscribed = false;
      return gone;
    },
  };
  const registration = { pushManager: { getSubscription: async () => (stillSubscribed ? subscription : null) } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { getRegistration: async () => registration }, userAgent: "Sweep" } });
  (globalThis as Record<string, unknown>).window = { PushManager: class {}, Notification: class {}, navigator: globalThis.navigator };
  (globalThis as Record<string, unknown>).Notification = { permission: "granted" };
  globalThis.fetch = (async (_url: string, init: RequestInit) => { asked.push(JSON.parse(String(init.body))); return serverAnswer(); }) as typeof fetch;
  const toggle = await mount(CommunityPushToggle, { handle: "sweepshop", publicKey: "BSweepKey", devices: 1, words: t });
  const before = texts(toggle.tree()).join(" | ");
  const off = find(toggle.tree(), (n) => n.type === "button" && texts(n.props?.children).includes(t.turnOff))[0];
  await (off.props!.onClick as () => Promise<void>)();
  await toggle.settle();
  return { asked, before, after: texts(toggle.tree()).join(" | "), stillSubscribed };
}

const ok = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

async function main() {
  part("Healthy control: server removes the device, browser unsubscribes");
  const good = await pressOff(ok, async () => true);
  is("shown as on before", good.before.includes(t.onHere), true);
  is("off sent", (good.asked[0] as { action?: string }).action, "off");
  is("switch back to Turn on", good.after.includes(t.turnOn), true);
  is("browser subscription gone", good.stillSubscribed, false);

  for (const [label, server, browser] of [
    ["server { ok: false } 503, unsubscribe() resolves false", async () => new Response(JSON.stringify({ ok: false, error: "unavailable" }), { status: 503 }), async () => false],
    ["connection dropped, unsubscribe() rejects", async () => { throw new TypeError("Failed to fetch"); }, async () => { throw new Error("AbortError"); }],
  ] as const) {
    part(`Defect: ${label}`);
    const bad = await pressOff(server, browser);
    is("browser still subscribed (notifications keep arriving)", bad.stillSubscribed, true);
    is("DEFECT: switch shows \"Turn notifications on\" as if off", bad.after.includes(t.turnOn), true);
    is("DEFECT: no error shown", bad.after.includes(t.failed), false);
  }
  done();
}
void main();
