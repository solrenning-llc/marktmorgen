/**
 * 639 [GL7](26) unit 3: a long form's answers kept in the visitor's own
 * browser, only when they check the box, forgotten when sent, unchecked or
 * thirty days old. Nothing is sent anywhere for it.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KEEP_DAYS, forget, keepKey, keptAnswers, read } from "@/components/form-keep";
import { offersKeep, parseForm, type FormDef } from "@/lib/forms";
import { FORM_WORDS } from "@/lib/buyer-words/form";
import { BlockView, type BlockContext } from "@/components/sales-blocks";
import { done, is, part } from "./check";

const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };

const field = (id: string, type = "short") => ({ id, type, label: `Question ${id}`, required: false, options: [] });
const base = { id: "frm0000001", name: "Application", button: "", doneHeading: "", doneBody: "", outcomes: [], offerList: false, updatedAt: 1 };

part("Which forms offer it");
is("four questions or more", offersKeep({ fields: [field("aaaaaa"), field("bbbbbb"), field("cccccc"), field("dddddd")] as never }), true);
is("one to write at length", offersKeep({ fields: [field("aaaaaa", "long")] as never }), true);
is("a short form does not", offersKeep({ fields: [field("aaaaaa", "email"), field("bbbbbb")] as never }), false);

part("What is kept");
is("only the answers to its questions, never a hidden field or the box to hear from the creator", keptAnswers([["handle", "shop"], ["form", "frm0000001"], ["q_aaaaaa", "Hello"], ["q_bbbbbb", ""], ["consent", "yes"], ["website", ""]]), [["q_aaaaaa", "Hello"]]);
const key = keepKey("shop", "frm0000001");
is("under the store and the form", key, "mm-form:shop:frm0000001");
store.set(key, JSON.stringify({ at: Date.now() - 1000, answers: [["q_aaaaaa", "Hello"]] }));
is("read back while fresh", read(key)?.answers, [["q_aaaaaa", "Hello"]]);
store.set(key, JSON.stringify({ at: Date.now() - (KEEP_DAYS * 86_400_000 + 1), answers: [["q_aaaaaa", "Old"]] }));
is(`older than ${KEEP_DAYS} days: forgotten, and gone from the browser`, [read(key), store.has(key)], [null, false]);
store.set(key, "{not json");
is("unreadable: nothing", read(key), null);
store.set(key, JSON.stringify({ at: Date.now(), answers: [] }));
forget(key);
is("forgotten on request", store.has(key), false);

part("Said in every language of the store");
is("each language says the three in its own words", Object.entries(FORM_WORDS).every(([lang, w]) => [w.keepLabel, w.keepHelp, w.keepBack].every((t) => t.length > 10) && (lang === "en" || w.keepLabel !== FORM_WORDS.en.keepLabel)), true);
is("it says where they stay and to leave it off on a shared computer", FORM_WORDS.en.keepHelp, "They stay in this browser only and are sent nowhere before you press the button. Leave this off on a shared computer.");

part("On the page");
const long = parseForm({ ...base, fields: [field("aaaaaa", "long")] }) as FormDef;
const ctx: BlockContext = { storeName: "Shop", productTitle: "", picture: null, photo: null, action: { kind: "none" } as never, defaultLabel: "", now: 1_790_000_000, lang: "en", forms: { [long.id]: long }, formTarget: { handle: "shop", page: "p1", funnel: "", listOpen: false } };
const html = renderToStaticMarkup(createElement(BlockView, { block: { id: "blk001", kind: "form", heading: "", form: long.id } as never, ctx, reviews: null }));
is("the server draws no box: it shows only once the page runs scripts", html.includes(FORM_WORDS.en.keepLabel), false);
const source = readFileSync("components/form-keep.tsx", "utf8");
is("the box has no name, so it is never sent with the answers", /<input\s+type="checkbox"\s+checked=\{on\}/.test(source) && !/name=/.test(source.slice(source.indexOf("<input"), source.indexOf("/>", source.indexOf("<input")))), true);
is("empty until checked: nothing kept unless asked", source.includes("useState(kept !== null)") && source.includes("if (!el || !on) return;"), true);
is("sending forgets them", source.includes('el.addEventListener("submit", sent)'), true);
is("nothing is fetched or sent for it", /fetch\(|sendBeacon|XMLHttpRequest/.test(source), false);
const blocks = readFileSync("components/sales-blocks.tsx", "utf8");
is("offered on a store's live page only, never in the studio's preview", blocks.includes("{offersKeep(form) && !ctx.preview && target ? <FormKeep"), true);

done();
