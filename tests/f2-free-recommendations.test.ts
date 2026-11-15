/**
 * 119 [F2-FREE-RECOMMENDATIONS], unit 1: a creator recommends up to three
 * other Marktmorgen stores on the page a new subscriber lands on after
 * confirming (/@handle/join?status=joined). Free: no payment either way, and
 * nobody is signed up to another list: the subscriber only sees links to the
 * other stores' own pages and chooses for themselves. Nothing about the
 * subscriber goes with the link.
 *
 * What fails here:
 *   - a pick kept that is not a store address, a fourth pick, a repeat;
 *   - the creator's own store, a store that does not exist or a suspended one
 *     accepted at saving, or shown on the page;
 *   - the stores read before the public requests are paid for, or read when
 *     they are refused;
 *   - the page carrying the subscriber's address or token in a link, or a
 *     form or a checkbox that would sign them up anywhere;
 *   - a buyer language without the words.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { claimHandle, setJoin, storeForEmail, type Store } from "@/lib/store";
import { MAX_RECOMMEND, parseJoinBox } from "@/lib/store-field-rules";
import { checkRecommended, readRecommended } from "@/lib/join-recommend";
import { JoinRecommendations } from "@/components/join-recommendations";
import { joinWords } from "@/lib/buyer-words/join";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("The picks, as saved");
  is("none by default", parseJoinBox({ on: true }).recommend, []);
  is("addresses tidied, an @ dropped, repeats and non-addresses dropped", parseJoinBox({ recommend: ["@Harbor", "harbor", "not an address!", "  quill-press "] }).recommend, ["harbor", "quill-press"]);
  is(`at most ${MAX_RECOMMEND}`, parseJoinBox({ recommend: ["aa1", "bb2", "cc3", "dd4"] }).recommend, ["aa1", "bb2", "cc3"]);
  is("not a list: none", parseJoinBox({ recommend: "harbor" }).recommend, []);

  redis.clear();
  await claimHandle("me@example.com", "mykitchen", "My Kitchen", "");
  await claimHandle("a@example.com", "harbor", "Harbor Press", "");
  await claimHandle("b@example.com", "quillpress", "Quill Press", "");
  await claimHandle("c@example.com", "shutshop", "Shut Shop", "");
  // A suspended store (lib/takedown.ts) is never recommended.
  const shut = (await storeForEmail("c@example.com"))!;
  const { ownerKey } = await import("@/lib/store");
  await redis.pipeline([["SET", await ownerKey("c@example.com"), JSON.stringify({ ...shut, suspended: "2026-11-15T00:00:00.000Z" })]]);
  const me = (await storeForEmail("me@example.com"))!;

  part("Checked at saving");
  is("real stores pass", await checkRecommended(me, ["harbor", "quillpress"]), { ok: true });
  is("the creator's own store is refused", await checkRecommended(me, ["mykitchen"]), { ok: false, refused: ["mykitchen"] });
  is("a store that does not exist is refused", await checkRecommended(me, ["harbor", "ghoststore"]), { ok: false, refused: ["ghoststore"] });
  is("a suspended store is refused", await checkRecommended(me, ["shutshop"]), { ok: false, refused: ["shutshop"] });
  await setJoin("me@example.com", { on: true, heading: "", line: "", recommend: ["harbor", "quillpress"] });
  const saved = (await storeForEmail("me@example.com"))!;
  is("saved with the box", saved.join.recommend, ["harbor", "quillpress"]);

  part("Read for the page, paid for first");
  const asked: number[] = [];
  const allow = async (_s: Store, _w: "public", _n: undefined, units: number) => (asked.push(units), true);
  const shown = await readRecommended(saved, allow);
  is("one public request per store, taken before reading", asked, [2]);
  is("the stores, by name and address", shown, [{ handle: "harbor", name: "Harbor Press" }, { handle: "quillpress", name: "Quill Press" }]);
  let reads = 0;
  const counting = async (handle: string) => {
    reads++;
    return (await import("@/lib/store")).storeForHandle(handle);
  };
  is("refused: nothing shown", await readRecommended(saved, async () => false, counting), []);
  is("refused: no store read", reads, 0);
  // A store recommended before it was suspended, or before it went, is left out when the page is drawn.
  const later = { ...saved, join: { ...saved.join, recommend: ["harbor", "shutshop", "ghoststore", "mykitchen"] } };
  is("suspended, gone or itself: left out on the page", (await readRecommended(later, allow)).map((s) => s.handle), ["harbor"]);
  const none = { ...saved, join: { ...saved.join, recommend: [] } };
  asked.length = 0;
  is("no picks: nothing taken, nothing read", [await readRecommended(none, allow), asked], [[], []]);

  part("On the page");
  const html = renderToStaticMarkup(createElement(JoinRecommendations, { from: "My Kitchen", stores: shown, language: "en" }));
  const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  is("says who recommends them", text.includes(joinWords("en").recommendHeading("My Kitchen")), true);
  is("says it is free and their own choice", text.includes(joinWords("en").recommendNote), true);
  is("links to each store's own page", html.includes('href="/@harbor"') && html.includes('href="/@quillpress"'), true);
  is("each link names its store", text.includes("Harbor Press") && text.includes("Quill Press"), true);
  is("nothing about the subscriber in any link", /href="[^"]*(\?|token|email|%40)/.test(html), false);
  is("no form, no checkbox, no hidden field", /<form|type="checkbox"|type="hidden"/.test(html), false);
  is("a named list", /<section[^>]*aria-labelledby=/.test(html) && /<ul/.test(html), true);
  is("nothing drawn without stores", renderToStaticMarkup(createElement(JoinRecommendations, { from: "My Kitchen", stores: [], language: "en" })), "");

  part("Every buyer language has the words");
  for (const code of LANGUAGE_CODES) {
    const w = joinWords(code);
    is(`${code}: heading names the store`, w.recommendHeading("Zed Shop").includes("Zed Shop"), true);
    is(`${code}: a note`, w.recommendNote.length > 20, true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
