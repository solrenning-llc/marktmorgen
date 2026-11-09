/**
 * 757 [STN4] unit 3: after the store's first sale, the studio asks the creator
 * to turn on two-step login. Synthetic data only.
 *
 * - The first sale is read exactly from the mark lib/yearly-offer.ts keeps
 *   (noteFirstSale): a reply in another shape is unknown, and unknown never
 *   shows the ask, so it never nags falsely.
 * - Only an account with no second step at all is asked: no app, no passkey,
 *   each read for sure; a session that is locked has its own notice.
 * - It can be dismissed, and the dismissal is kept in this browser under the
 *   store's own bounded key: no read, write or key on our side.
 * - It never blocks selling: nothing that decides a sale reads it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TwoStepAsk } from "@/components/two-step-ask";
import {
  TWO_STEP_ASK_DISMISSED,
  TWO_STEP_ASK_HREF,
  TWO_STEP_ASK_PREFIX,
  TWO_STEP_ASK_WORDS,
  askShown,
  firstSaleFromReply,
  noSecondStep,
  showTwoStepAsk,
  twoStepAskKey,
} from "@/lib/two-step-ask-rules";
import { firstSaleKnown } from "@/lib/two-step-ask";
import { claimValue } from "@/lib/claim-mark";
import { firstSaleKey } from "@/lib/yearly-offer";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const SID = "0123456789abcdef0123456789abcdef";
const shop = { sid: SID, handle: "synthetic-bakery" };

async function main() {
  part("The first sale, read exactly from its mark");
  is("nothing kept: confirmed no sale yet (0)", firstSaleFromReply(null), 0);
  is("the day in seconds (a mark from before the random part)", firstSaleFromReply("1730000000"), 1730000000);
  is("the day and the random part claimValue adds", firstSaleFromReply("1730000000.123456789"), 1730000000);
  for (const [label, reply] of [
    ["a number, not the string Redis keeps", 1730000000],
    ["true", true],
    ["an object", {}],
    ["an array", ["1730000000"]],
    ["an empty string", ""],
    ["zero", "0"],
    ["a negative day", "-1730000000"],
    ["an exponent", "1e9"],
    ["spaces around it", " 1730000000"],
    ["words", "sold"],
    ["a day too long to be seconds", "17300000000000000"],
    ["undefined", undefined],
  ] as const) {
    is(`${label}: unknown (null), never "sold" and never "not yet"`, firstSaleFromReply(reply), null);
  }

  redis.clear();
  is("the server reader: no mark is 0", await firstSaleKnown(shop), 0);
  await redis.pipeline([["SET", firstSaleKey(shop), claimValue(1730000000)]]);
  is("the server reader: the mark noteFirstSale writes reads as its day", await firstSaleKnown(shop), 1730000000);
  const original = redis.pipeline.bind(redis);
  const replies: [string, unknown][] = [
    ["no envelope", []],
    ["two replies for one command", ["1730000000", "x"]],
    ["a number", [1730000000]],
    ["a word", ["soon"]],
  ];
  for (const [label, reply] of replies) {
    redis.pipeline = async () => reply as unknown[];
    try {
      is(`the server reader: ${label} is unknown (null)`, await firstSaleKnown(shop), null);
    } finally {
      redis.pipeline = original;
    }
  }
  redis.pipeline = async () => {
    throw new Error("synthetic network failure");
  };
  try {
    is("the server reader: Redis not answering is unknown (null)", await firstSaleKnown(shop), null);
  } finally {
    redis.pipeline = original;
  }
  let commands: unknown[] = [];
  redis.pipeline = async (sent: (string | number)[][]) => {
    commands = sent;
    return original(sent);
  };
  try {
    await firstSaleKnown(shop);
  } finally {
    redis.pipeline = original;
  }
  is("the server reader sends one GET of the mark and nothing else", commands, [["GET", firstSaleKey(shop)]]);

  part("Who is asked");
  const bare = { appOn: false, passkeys: 0, locked: false };
  is("no app and no passkey: no second step", noSecondStep(bare), true);
  is("after the first sale, an account with no second step is asked", showTwoStepAsk({ ...bare, firstSale: 1730000000 }), true);
  is("before the first sale: not asked", showTwoStepAsk({ ...bare, firstSale: 0 }), false);
  is("first sale unknown: not asked (never a false nag)", showTwoStepAsk({ ...bare, firstSale: null }), false);
  is("the app already on: not asked", showTwoStepAsk({ ...bare, appOn: true, firstSale: 1730000000 }), false);
  is("the app unread: not asked", showTwoStepAsk({ ...bare, appOn: null, firstSale: 1730000000 }), false);
  is("a passkey is a second step: not asked", showTwoStepAsk({ ...bare, passkeys: 1, firstSale: 1730000000 }), false);
  is("passkeys unread: not asked", showTwoStepAsk({ ...bare, passkeys: null, firstSale: 1730000000 }), false);
  is("a locked session has its own notice: not asked", showTwoStepAsk({ ...bare, locked: true, firstSale: 1730000000 }), false);

  part("Dismissed once, remembered per store, in this browser");
  is("the key is the store's own", twoStepAskKey(SID), `${TWO_STEP_ASK_PREFIX}${SID}`);
  is("a bounded key: prefix and a 32-character store id", twoStepAskKey(SID)?.length, TWO_STEP_ASK_PREFIX.length + 32);
  is("an id we never make has no key (nothing is shown)", [twoStepAskKey(""), twoStepAskKey("x".repeat(5000)), twoStepAskKey("../secret"), twoStepAskKey(SID.toUpperCase())], [null, null, null, null]);
  is("the dismissal is one short exact value", TWO_STEP_ASK_DISMISSED, "1");
  is("nothing kept and storage that writes: shown", askShown(null, true), true);
  is("dismissed: never shown again in this browser", askShown(TWO_STEP_ASK_DISMISSED, true), false);
  is("a value we never write: not shown (never shown again and again)", askShown("yes", true), false);
  is("storage blocked: not shown, since a dismissal could not be kept", askShown(undefined, true), false);
  is("storage that reads but cannot write: not shown", askShown(null, false), false);

  part("Nothing is drawn on the server, so it never guesses");
  const markup = renderToStaticMarkup(createElement(TwoStepAsk, { sid: SID }));
  is("server markup is only the empty status region", markup, '<div role="status"></div>');

  part("Words: what to do and why, in plain US English");
  const w = TWO_STEP_ASK_WORDS;
  is("the title names the first sale", /first sale/i.test(w.title), true);
  is("the body says what to do", /turn on two-step login/i.test(w.body), true);
  is("the body says why: the email alone no longer opens the studio", /email/i.test(w.body) && /phone/i.test(w.body), true);
  is("the body says selling does not stop", /keeps selling/i.test(w.body), true);
  is("the link says where it goes", w.link, "Turn on two-step login");
  is("the dismiss button says what it does", w.dismiss, "Don't show this again");
  is("after dismissing, it says where to find it again", /Two-step login/.test(w.dismissed), true);
  is("no urgency, fear or exclamation", /\b(now|urgent|hurry|immediately|danger|hacked|warning)\b|!/i.test(Object.values(w).join(" ")), false);
  is("no generic link text", /\b(click|here)\b/i.test(w.link), false);
  is("short sentences (at most 25 words each)", Object.values(w).flatMap((text) => text.split(/(?<=[.:])\s+/)).every((s) => s.split(/\s+/).length <= 25), true);
  is("the link goes to Two-step login", TWO_STEP_ASK_HREF, "#two-step");
  is("Two-step login has that anchor", read("components/two-step-manager.tsx").includes('<section id="two-step"'), true);

  part("Accessibility (AX274)");
  const component = read("components/two-step-ask.tsx");
  is("a status region, there from the first paint so its message is said", component.includes('role="status"'), true);
  is("named by its heading", component.includes('aria-labelledby="two-step-ask-title"') && component.includes('id="two-step-ask-title"'), true);
  is("the link is at least 44 px high", /href=\{TWO_STEP_ASK_HREF\}[^>]*min-h-11/.test(component), true);
  is("the dismiss button is at least 44 by 44 px", /type="button"[\s\S]*min-h-11 min-w-11/.test(component), true);
  is("no time limit, no timer", /setTimeout|setInterval|requestAnimationFrame/.test(component), false);
  is("no animation of its own", /animate-|transition/.test(component), false);
  is("never takes the focus on its own", /autoFocus/.test(component), false);
  is("after dismissing, the focus goes to the line that says so, never to the top", component.includes("said.current?.focus()"), true);
  is("information is in words, not color", !/text-(?:danger|warn|success)|notice-warn/.test(component), true);

  part("The studio draws it from what it already reads, and it never blocks selling");
  const page = read("app/studio/page.tsx");
  is("the first sale is read only for an account with no second step", page.includes("const soldFirstAt = store && noSecondStep({ appOn: twoStepRead === null ? null : twoStep.on, passkeys: passkeysRead === null ? null : passkeysRead.length, locked: lockedTill > 0 }) ? await firstSaleKnown(store) : null;"), true);
  is(
    "drawn only under the rule",
    page.includes("{store && showTwoStepAsk({ firstSale: soldFirstAt, appOn: twoStepRead === null ? null : twoStep.on, passkeys: passkeysRead === null ? null : passkeysRead.length, locked: lockedTill > 0 }) ? <TwoStepAsk sid={store.sid} /> : null}"),
    true,
  );
  is("drawn once on the page", page.split("<TwoStepAsk ").length - 1, 1);
  is("passkeys not read are not taken for none here", page.includes("listPasskeys(email).catch(() => null)"), true);
  const rules = read("lib/two-step-ask-rules.ts");
  is("the rules and the component read nothing from the server", /fetch\(|redis|@\/lib\/(?:passkeys|two-step"|store")/i.test(component + rules), false);
  const selling = ["lib/opening.ts", "lib/store-checkout.ts", "lib/checkout-sweep.ts", "lib/yearly-offer.ts"].filter((file) => /two-step-ask/.test(read(file)));
  is("nothing that sells or notes a sale reads it", selling, []);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
