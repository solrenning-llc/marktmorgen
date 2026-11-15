/**
 * Two client components that told a person something happened without
 * reading the answer (docs/reviews/c5-sweep-app6.md, findings 1, 3 and 5):
 *
 *   - components/next-offer-box.tsx: "No thanks" said "It won't be suggested
 *     again for this order." whatever the server answered. The route answers
 *     { ok: false } with 429 (rate limit) and 404 (nothing kept), and a dropped
 *     connection never reaches it; then the same offer comes back on reload.
 *   - components/community-push-toggle.tsx: "Turn off on this device" showed
 *     the switch as off whatever the server and the browser answered, so the
 *     device could keep getting notifications shown as turned off, or keep a
 *     device row on the server (counted toward the member's devices).
 *
 * The components' real code runs under tests/client-hooks.ts (React's own
 * hooks, re-rendered after each state change), with fetch and the browser's
 * push objects replaced by synthetic ones. Nothing real is sent.
 */
import { NextOfferBox } from "@/components/next-offer-box";
import { CommunityPushToggle } from "@/components/community-push-toggle";
import { nextOfferWords, NEXT_OFFER_WORDS } from "@/lib/buyer-words/next-offer";
import { communityWords } from "@/lib/buyer-words/community";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

const json = (body: unknown, status: number) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html503 = async () => new Response("<html>unavailable</html>", { status: 503 });
const html200 = async () => new Response("<html>a proxy page</html>", { status: 200 });
const dropped = async (): Promise<Response> => { throw new TypeError("Failed to fetch"); };

const alerts = (tree: unknown) => find(tree, (n) => n.props?.role === "alert").map((n) => texts(n.props?.children).join(""));
const statuses = (tree: unknown) => find(tree, (n) => n.props?.role === "status").map((n) => texts(n.props?.children).join(""));
const button = (tree: unknown, label: string) => find(tree, (n) => n.type === "button" && texts(n.props?.children).includes(label))[0] as Node | undefined;
/** Presses a button; a missing one is a failed check below it, not a crash, so every part still runs. */
const click = (node: Node | undefined) => (node?.props?.onClick as (() => unknown) | undefined)?.();

// ---- Next product after a purchase: "No thanks" ------------------------------------------------

const w = nextOfferWords("en");
const offerProps = {
  handle: "answershop",
  session: "cs_test_answers000000000000000",
  href: "/@answershop/p/next",
  see: w.see,
  dismiss: w.dismiss,
  dismissed: w.dismissed,
  failed: w.dismissFailed,
  note: "",
  children: null,
};

async function offerBox(answers: (() => Promise<Response>)[]) {
  const sent: unknown[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    const answer = answers[Math.min(sent.length - 1, answers.length - 1)];
    return answer();
  }) as typeof fetch;
  const box = await mount(NextOfferBox, offerProps);
  const press = async () => {
    click(button(box.tree(), w.dismiss));
    await box.settle();
  };
  return { box, sent, press };
}

async function nextOffer() {
  part("Next offer, healthy control: the server kept the dismissal (200, ok: true)");
  {
    const { box, sent, press } = await offerBox([json({ ok: true }, 200)]);
    await press();
    is("one dismissal sent, with the order", sent, [{ h: "answershop", s: "cs_test_answers000000000000000" }]);
    is("buyer told it will not be suggested again, as a status", statuses(box.tree()), [w.dismissed]);
    is("no error", alerts(box.tree()), []);
    is("the offer is gone", button(box.tree(), w.dismiss), undefined);
  }

  for (const [label, answer] of [
    ["429 { ok: false } (rate limit)", json({ ok: false }, 429)],
    ["404 { ok: false } (nothing kept)", json({ ok: false }, 404)],
    ["503 page that is not JSON", html503],
    ["200 page that is not JSON", html200],
    ["200 { ok: false }", json({ ok: false }, 200)],
    ["connection dropped", dropped],
  ] as const) {
    part(`Next offer, not kept: ${label}`);
    const { box, sent, press } = await offerBox([answer, json({ ok: true }, 200)]);
    await press();
    const said = texts(box.tree()).join(" ");
    is("never told it won't be suggested again", said.includes(w.dismissed), false);
    is("told plainly it did not go through, as an alert", alerts(box.tree()), [w.dismissFailed]);
    const again = button(box.tree(), w.dismiss);
    is("the offer and its No thanks stay", !!again, true);
    is("No thanks can be pressed again", again?.props?.["aria-disabled"] === true || again?.props?.["aria-disabled"] === "true", false);
    await press();
    is("pressing again sends a second dismissal", sent.length, 2);
    is("and once kept, the buyer is told so and the error goes", [statuses(box.tree()), alerts(box.tree())], [[w.dismissed], []]);
  }

  part("Next offer, while sending: focus is kept and nothing is sent twice");
  {
    let release: (r: Response) => void = () => {};
    const { box, sent } = await offerBox([() => new Promise<Response>((r) => { release = r; })]);
    click(button(box.tree(), w.dismiss));
    await box.settle();
    const busy = button(box.tree(), w.dismiss);
    is("button stays focusable (aria-disabled, not disabled)", [busy?.props?.disabled ?? false, busy?.props?.["aria-disabled"]], [false, true]);
    click(busy);
    await box.settle();
    is("a second press while sending sends nothing", sent.length, 1);
    release(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await box.settle();
    is("then the kept answer is shown", statuses(box.tree()), [w.dismissed]);
  }

  part("Next offer: every language has the new sentence");
  is("dismissFailed in every language", Object.entries(NEXT_OFFER_WORDS).filter(([, words]) => !words.dismissFailed?.trim()).map(([code]) => code), []);
}

// ---- Community notifications: "Turn off on this device" ---------------------------------------

const t = communityWords("en").push;

type Browser = () => Promise<boolean>;

async function pushToggle(server: (() => Promise<Response>)[], browser: Browser[], registrationFails = false) {
  const sent: { action?: string; endpoint?: string }[] = [];
  let unsubscribeCalls = 0;
  let subscribed = true;
  const subscription = {
    endpoint: "https://push.example.test/answers",
    unsubscribe: async () => {
      const answer = browser[Math.min(unsubscribeCalls, browser.length - 1)];
      unsubscribeCalls++;
      const gone = await answer();
      if (gone) subscribed = false;
      return gone;
    },
  };
  let lookups = 0;
  const registration = { pushManager: { getSubscription: async () => (subscribed ? subscription : null) } };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: {
        getRegistration: async () => {
          // The first lookup is the page reading the state; later ones are the switch.
          if (lookups++ > 0 && registrationFails) throw new Error("InvalidStateError");
          return registration;
        },
      },
      userAgent: "Answers",
    },
  });
  (globalThis as Record<string, unknown>).window = { PushManager: class {}, Notification: class {}, navigator: globalThis.navigator };
  (globalThis as Record<string, unknown>).Notification = { permission: "granted" };
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return server[Math.min(sent.length - 1, server.length - 1)]();
  }) as typeof fetch;
  const toggle = await mount(CommunityPushToggle, { handle: "answershop", publicKey: "BAnswersKey", devices: 1, words: t });
  const pressOff = async () => {
    // A rejected handler is an unhandled rejection in the page; the checks read what the person sees.
    await Promise.resolve(click(button(toggle.tree(), t.turnOff))).catch(() => {});
    await toggle.settle();
  };
  return { toggle, sent, pressOff, state: () => ({ subscribed, unsubscribeCalls }) };
}

const serverOff = json({ ok: true, devices: 0 }, 200);

async function communityPush() {
  part("Notifications off, healthy control: server forgets the device, browser unsubscribes");
  {
    const { toggle, sent, pressOff, state } = await pushToggle([serverOff], [async () => true]);
    is("shown as on before", texts(toggle.tree()).includes(t.onHere), true);
    await pressOff();
    is("off sent for this device", sent, [{ handle: "answershop", action: "off", endpoint: "https://push.example.test/answers" }]);
    is("browser subscription gone", state().subscribed, false);
    is("switch back to Turn notifications on", !!button(toggle.tree(), t.turnOn), true);
    is("no error", alerts(toggle.tree()), []);
  }

  for (const [label, server] of [
    ["server { ok: false } 503", json({ ok: false, error: "unavailable" }, 503)],
    ["server 403 { ok: false, error: out }", json({ ok: false, error: "out" }, 403)],
    ["server 500 page that is not JSON", html503],
    ["server 200 page that is not JSON", html200],
    ["connection dropped", dropped],
  ] as const) {
    part(`Notifications off, server did not forget the device: ${label}`);
    const { toggle, sent, pressOff, state } = await pushToggle([server, serverOff], [async () => true]);
    await pressOff();
    is("browser left subscribed, so browser and server still agree", [state().subscribed, state().unsubscribeCalls], [true, 0]);
    is("told plainly they could not be turned off, as an alert", alerts(toggle.tree()), [t.offFailed]);
    is("still shown as on, with Turn off to try again", [texts(toggle.tree()).includes(t.onHere), !!button(toggle.tree(), t.turnOff), !!button(toggle.tree(), t.turnOn)], [true, true, false]);
    await pressOff();
    is("trying again sends off again", sent.map((s) => s.action), ["off", "off"]);
    is("and once both are done it is off, with no error", [state().subscribed, !!button(toggle.tree(), t.turnOn), alerts(toggle.tree())], [false, true, []]);
  }

  // Once the server answered { ok: true } it has forgotten the device, and
  // pushes go only to the devices it keeps, so nothing reaches this browser
  // any more: the switch is off, with the server's count, and no error. The
  // browser's subscription is dropped quietly, with one more try if the first
  // did not take (review 6698746219 on #2983).
  for (const [label, browser, droppedAtLast] of [
    ["unsubscribe() resolves false, then true", [async () => false, async () => true], true],
    ["unsubscribe() rejects, then true", [async (): Promise<boolean> => { throw new Error("AbortError"); }, async () => true], true],
    ["unsubscribe() resolves false twice", [async () => false, async () => false], false],
    ["unsubscribe() rejects twice", [async (): Promise<boolean> => { throw new Error("AbortError"); }], false],
  ] as const) {
    part(`Notifications off, the server forgot the device but the browser kept the subscription: ${label}`);
    const { toggle, sent, pressOff, state } = await pushToggle([serverOff], [...browser]);
    await pressOff();
    is("off sent once", sent.map((s) => s.action), ["off"]);
    is("the browser is asked once more, quietly", [state().unsubscribeCalls, state().subscribed], [2, !droppedAtLast]);
    is("shown as off, with Turn notifications on", [texts(toggle.tree()).includes(t.onHere), !!button(toggle.tree(), t.turnOff), !!button(toggle.tree(), t.turnOn)], [false, false, true]);
    is("never told they could not be turned off", alerts(toggle.tree()), []);
  }

  part("Notifications off, the server forgot the device: the count is the server's");
  {
    const { toggle, pressOff } = await pushToggle([json({ ok: true, devices: 2 }, 200)], [async () => false]);
    await pressOff();
    (globalThis as Record<string, unknown>).Notification = { permission: "granted", requestPermission: async () => "granted" };
    (globalThis.navigator as unknown as { serviceWorker: Record<string, unknown> }).serviceWorker.register = async () => ({
      pushManager: { getSubscription: async () => null, subscribe: async () => ({ endpoint: "https://push.example.test/again", toJSON: () => ({}), unsubscribe: async () => true }) },
    });
    (globalThis.navigator as unknown as { serviceWorker: Record<string, unknown> }).serviceWorker.ready = Promise.resolve();
    // A reply to "on" without a count: the page adds this device to the count it holds.
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    await click(button(toggle.tree(), t.turnOn));
    await toggle.settle();
    is("turned on again, the count starts from the server's 2, not the old 1", texts(toggle.tree()).includes(t.onMany.replace("{n}", "3")), true);
  }

  part("Notifications off, the browser's registration cannot be read");
  {
    const { toggle, sent, pressOff } = await pushToggle([serverOff], [async () => true], true);
    await pressOff();
    is("nothing sent", sent, []);
    is("told plainly, still shown as on", [alerts(toggle.tree()), !!button(toggle.tree(), t.turnOff)], [[t.offFailed], true]);
  }

  part("Notifications off, while working: focus is kept");
  {
    let release: (r: Response) => void = () => {};
    const { toggle, sent } = await pushToggle([() => new Promise<Response>((r) => { release = r; })], [async () => true]);
    const pressing = click(button(toggle.tree(), t.turnOff));
    await toggle.settle();
    const busy = button(toggle.tree(), t.turnOff);
    is("Turn off stays focusable (aria-disabled, not disabled)", [busy?.props?.disabled ?? false, busy?.props?.["aria-disabled"]], [false, true]);
    void Promise.resolve(click(busy)).catch(() => {});
    await toggle.settle();
    is("a second press while working sends nothing", sent.length, 1);
    release(new Response(JSON.stringify({ ok: true, devices: 0 }), { status: 200 }));
    await pressing;
    await toggle.settle();
    is("then it is off", !!button(toggle.tree(), t.turnOn), true);
  }

  part("Notifications on, sibling: a refusal is an alert");
  {
    const { toggle } = await pushToggle([serverOff], [async () => true]);
    await click(button(toggle.tree(), t.turnOff));
    await toggle.settle();
    (globalThis as Record<string, unknown>).Notification = { permission: "granted", requestPermission: async () => "granted" };
    (globalThis.navigator as unknown as { serviceWorker: Record<string, unknown> }).serviceWorker.register = async () => ({
      pushManager: { getSubscription: async () => null, subscribe: async () => ({ endpoint: "https://push.example.test/again", toJSON: () => ({}), unsubscribe: async () => true }) },
    });
    (globalThis.navigator as unknown as { serviceWorker: Record<string, unknown> }).serviceWorker.ready = Promise.resolve();
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: "noroom" }), { status: 409 })) as typeof fetch;
    await click(button(toggle.tree(), t.turnOn));
    await toggle.settle();
    is("the refusal is read out as an alert", alerts(toggle.tree()), [t.noroom]);
    is("still off, Turn notifications on can be pressed again", [!!button(toggle.tree(), t.turnOn), button(toggle.tree(), t.turnOn)?.props?.["aria-disabled"] ?? false], [true, false]);
  }

  part("Notifications on: a device the server refuses for good is told so, never to try again");
  {
    // The server answers "invalid" when this browser's subscription is not one a member's device may be kept with
    // (lib/community-push.ts rememberDevice): another press makes the same subscription, so "Try again" never works.
    const { toggle } = await pushToggle([serverOff], [async () => true]);
    await click(button(toggle.tree(), t.turnOff));
    await toggle.settle();
    (globalThis as Record<string, unknown>).Notification = { permission: "granted", requestPermission: async () => "granted" };
    let undone = 0;
    (globalThis.navigator as unknown as { serviceWorker: Record<string, unknown> }).serviceWorker.register = async () => ({
      pushManager: {
        getSubscription: async () => null,
        subscribe: async () => ({ endpoint: "https://push.example.test/refused", toJSON: () => ({}), unsubscribe: async () => { undone += 1; return true; } }),
      },
    });
    (globalThis.navigator as unknown as { serviceWorker: Record<string, unknown> }).serviceWorker.ready = Promise.resolve();
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: "invalid" }), { status: 400 })) as typeof fetch;
    await click(button(toggle.tree(), t.turnOn));
    await toggle.settle();
    const refused = (t as Record<string, unknown>).refused;
    is("the words say it", typeof refused === "string" && refused.trim().length > 0, true);
    is("the refusal is read out as an alert, in its own words", alerts(toggle.tree()), [refused]);
    is("not the words that say to try again", alerts(toggle.tree()).some((said) => said === t.failed || /try again/i.test(said)), false);
    is("the browser is not left listening to nothing", undone, 1);
    is("control: still off", !!button(toggle.tree(), t.turnOn), true);
  }

  part("Notifications off: every language has the new sentence");
  const languages = ["en", "es", "fr", "de", "it", "nl", "pt"];
  const refusedOf = (code: string) => (communityWords(code).push as Record<string, unknown>).refused;
  is("refused in every language, each its own", languages.filter((code) => typeof refusedOf(code) !== "string" || !String(refusedOf(code)).trim() || (code !== "en" && refusedOf(code) === refusedOf("en"))), []);
  is("refused is never the try-again sentence, in any language", languages.filter((code) => refusedOf(code) === communityWords(code).push.failed), []);
  is("offFailed in every language, each its own", languages.filter((code) => !communityWords(code).push.offFailed?.trim() || (code !== "en" && communityWords(code).push.offFailed === t.offFailed)), []);
}

// A press left waiting forever would empty the event loop and end the run with
// code 0 before done(); that is a failure, never a pass.
process.on("exit", (code) => {
  if (code === 0 && !finished) {
    console.log("\nFAIL  the run ended before every check ran");
    process.exitCode = 1;
  }
});
let finished = false;

async function main() {
  await nextOffer();
  await communityPush();
  finished = true;
  done();
}
void main();
