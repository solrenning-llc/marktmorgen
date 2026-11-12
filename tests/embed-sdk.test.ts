/**
 * The checkout script (lib/embed-sdk.ts, lib/embed-sites.ts,
 * lib/embed-open.ts; added 17 October 2026). What is checked:
 *
 *   - the sites a store lists: https origins only, ten at most, refused as a
 *     whole when one line is wrong, saved on the store;
 *   - a Referer and a return address count only on a listed site;
 *   - the link: tagged, escaped, with the script under it, and nothing in it
 *     but the store, the product and the tags;
 *   - the script itself, run against a stand-in page: it takes only clicks
 *     on its own links, opens one frame, takes messages only from this site
 *     and that frame, turns them into events, closes, and says a purchase
 *     from the receipt's mark; it reads no cookie or storage and asks for
 *     nothing on load; its hash is the one the policy lines print;
 *   - the frame pages: buy buttons and messages only on a listed site, a
 *     plain link elsewhere, counted as a visit, and the checkout, the sign-up
 *     route and the receipt check the site again;
 *   - the webhooks: sale.completed carries its source, list.joined exists.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import {
  MAX_EMBED_SITES,
  PURCHASE_MARK_PATTERN,
  listedReturn,
  listedSite,
  parseEmbedSite,
  parseEmbedSites,
  purchaseReturn,
  readEmbedSites,
  scriptMode,
  scriptTags,
  scriptVia,
  withTags,
} from "@/lib/embed-sites";
import { cspLines, loaderHash, loaderSource, loaderTag, scriptCode, scriptHref } from "@/lib/embed-sdk";
import { isDynamicPage, isEmbedPage } from "@/lib/csp";
import { WEBHOOK_EVENTS, eventIdFor, sourceOf } from "@/lib/webhooks";
import { claimHandle, setEmbedSites, storeForEmail } from "@/lib/store";
import { done, is, part } from "./check";

const read = (path: string) => readFileSync(path, "utf8");

/** A page, as small as the script needs, that records what is done to it. */
function standIn(hash = "") {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const winListeners: Record<string, ((event: unknown) => void)[]> = {};
  const fired: { type: string; detail: unknown; on: string }[] = [];
  const appended: Record<string, unknown>[] = [];
  const touched: string[] = [];
  const make = (tag: string) => {
    const el: Record<string, unknown> = {
      tag,
      style: {},
      attributes: {} as Record<string, string>,
      children: [] as unknown[],
      setAttribute(name: string, value: string) {
        (el.attributes as Record<string, string>)[name] = value;
      },
      appendChild(child: Record<string, unknown>) {
        (el.children as unknown[]).push(child);
        child.parentNode = el;
      },
      removeChild(child: Record<string, unknown>) {
        el.children = (el.children as unknown[]).filter((c) => c !== child);
        child.parentNode = null;
      },
      // What has the focus is recorded on the page, as a browser's document.activeElement.
      focus() {
        document.activeElement = el;
      },
      contentWindow: tag === "iframe" ? { name: "frame-window", focus() { (el.contentWindow as Record<string, unknown>).focused = true; document.activeElement = el; } } : undefined,
    };
    // The browser's own modal dialog: what showModal does is recorded, nothing more.
    if (tag === "dialog") el.showModal = () => { el.modal = true; };
    return el;
  };
  const body = make("body");
  body.appendChild = (child: Record<string, unknown>) => {
    appended.push(child);
    child.parentNode = body;
  };
  body.removeChild = (child: Record<string, unknown>) => {
    const at = appended.indexOf(child);
    if (at >= 0) appended.splice(at, 1);
    child.parentNode = null;
  };
  const document = {
    activeElement: null as unknown,
    readyState: "complete",
    body,
    documentElement: { style: { overflow: "" } },
    createElement: make,
    addEventListener(type: string, fn: (event: unknown) => void) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    dispatchEvent(event: { type: string; detail: unknown }) {
      fired.push({ type: event.type, detail: event.detail, on: "document" });
      return true;
    },
    get cookie() {
      touched.push("cookie");
      return "";
    },
  };
  let replaced = "";
  const window = {
    location: { hash, pathname: "/thank-you", search: "?a=1" },
    addEventListener(type: string, fn: (event: unknown) => void) {
      (winListeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      winListeners[type] = (winListeners[type] ?? []).filter((f) => f !== fn);
    },
    get localStorage() {
      touched.push("localStorage");
      return {};
    },
    get sessionStorage() {
      touched.push("sessionStorage");
      return {};
    },
    fetch() {
      touched.push("fetch");
    },
  } as Record<string, unknown>;
  class CustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init: { detail: unknown }) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const timers: (() => void)[] = [];
  const context = {
    window,
    document,
    URL,
    CustomEvent,
    history: {
      state: null,
      replaceState(_state: unknown, _title: string, url: string) {
        replaced = url;
      },
    },
    setTimeout: (fn: () => void) => timers.push(fn),
  };
  runInNewContext(loaderSource(), context);
  const link = (href: string, mode: string, text = "Buy it") => {
    const el = make("a");
    el.href = href;
    el.textContent = text;
    el.isConnected = true;
    el.getAttribute = (name: string) => (name === "data-mm" ? mode : null);
    el.closest = (selector: string) => (selector === "a[data-mm]" ? el : null);
    el.dispatchEvent = (event: { type: string; detail: unknown }) => {
      fired.push({ type: event.type, detail: event.detail, on: "link" });
      return true;
    };
    return el;
  };
  const click = (target: unknown, extra: Record<string, unknown> = {}) => {
    let prevented = false;
    const event = { target, button: 0, defaultPrevented: false, preventDefault: () => (prevented = true), ...extra };
    for (const fn of listeners.click ?? []) fn(event);
    return prevented;
  };
  const message = (data: unknown, origin: string, source: unknown) => {
    for (const fn of winListeners.message ?? []) fn({ data, origin, source });
  };
  const key = (name: string) => {
    for (const fn of listeners.keydown ?? []) fn({ key: name });
  };
  return { window, document, fired, appended, touched, link, click, message, key, timers, replaced: () => replaced };
}

async function main(): Promise<void> {
  part("The sites a store lists");
  is(
    "an origin, however it is typed",
    [parseEmbedSite("example.com"), parseEmbedSite("https://Example.com/shop?x=1#y"), parseEmbedSite(" https://www.example.com/ "), parseEmbedSite("https://shop.example.com:8443")],
    ["https://example.com", "https://example.com", "https://www.example.com", "https://shop.example.com:8443"],
  );
  is(
    "never plain http, a wildcard, a user name, a bare word, an address of numbers or of this machine",
    [parseEmbedSite("http://example.com"), parseEmbedSite("*.example.com"), parseEmbedSite("https://me:pw@example.com"), parseEmbedSite("intranet"), parseEmbedSite("https://10.0.0.1"), parseEmbedSite("https://localhost"), parseEmbedSite("javascript:alert(1)"), parseEmbedSite(42)],
    [null, null, null, null, null, null, null, null],
  );
  const eleven = Array.from({ length: 11 }, (_, i) => `site${i}.example.com`);
  is("ten at most, and more is refused, not cut", [MAX_EMBED_SITES, readEmbedSites(eleven).ok, readEmbedSites(eleven.slice(0, 10)).ok], [10, false, true]);
  is("one wrong line refuses the whole list, and says which", readEmbedSites("example.com\nhttp://bad.example.com"), { ok: false, reason: "invalid", line: "http://bad.example.com" });
  is("lines, commas and repeats", readEmbedSites("example.com, https://example.com/\n\nblog.example.com"), { ok: true, sites: ["https://example.com", "https://blog.example.com"] });
  is("a saved list read back keeps only what is valid, ten at most", parseEmbedSites(["https://a.example.com", "nope", "https://a.example.com", ...eleven]).length, 10);

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  is("saved on the store", (await setEmbedSites("owner@example.com", ["www.example.com"])).ok, true);
  is("and read back with it", (await storeForEmail("owner@example.com"))?.embedSites, ["https://www.example.com"]);
  is("a list it cannot keep changes nothing", [(await setEmbedSites("owner@example.com", eleven)).ok, (await storeForEmail("owner@example.com"))?.embedSites], [false, ["https://www.example.com"]]);

  part("Which site a frame is on, and where a buyer is sent back to");
  const sites = ["https://www.example.com"];
  is("a Referer from a listed site, its origin", listedSite(sites, "https://www.example.com/blog/post?x=1"), "https://www.example.com");
  is("from any other, or none, nothing", [listedSite(sites, "https://example.com/"), listedSite(sites, "https://www.example.com.evil.net/"), listedSite(sites, null), listedSite([], "https://www.example.com/")], [null, null, null, null]);
  is("a return address on a listed site, without its fragment", listedReturn(sites, "https://www.example.com/thanks?from=mm#top"), "https://www.example.com/thanks?from=mm");
  is(
    "and never one elsewhere, on http, too long or not an address",
    [listedReturn(sites, "https://evil.example.net/"), listedReturn(sites, "http://www.example.com/"), listedReturn(sites, `https://www.example.com/${"a".repeat(400)}`), listedReturn(sites, "//www.example.com/x"), listedReturn(sites, ["https://www.example.com/"])],
    [null, null, null, null, "https://www.example.com/"],
  );
  is("the two modes, and nothing else", [scriptMode("overlay"), scriptMode("page"), scriptMode(["page"]), scriptMode("top"), scriptMode(undefined)], ["overlay", "page", "page", null, null]);
  is("an affiliate's code only in the shape of one", [scriptVia("Anna22"), scriptVia("a"), scriptVia("x".repeat(30)), scriptVia("<b>")], ["anna22", null, null, null]);
  is(
    "the tags cleaned, with the script's medium when none was given",
    scriptTags({ utm_source: "My Blog!", utm_campaign: "Spring Launch", utm_content: ["hero", "x"] }),
    { utm_source: "my-blog", utm_medium: "checkout-script", utm_campaign: "spring-launch", utm_content: "hero" },
  );
  is("empty tags are left off an address", withTags("/@h/p/x", { utm_source: "blog", utm_campaign: "" }, { via: null }), "/@h/p/x?utm_source=blog");

  part("The link");
  const href = scriptHref({ handle: "harbor", productId: "k3j9x2p1ab", place: "blog", campaign: "spring", back: "https://www.example.com/thanks" });
  is("the card as a page of its own, tagged, with the way back", href, "https://marktmorgen.com/embed/harbor/k3j9x2p1ab?mm=page&utm_source=blog&utm_medium=checkout-script&utm_campaign=spring&return=https%3A%2F%2Fwww.example.com%2Fthanks");
  is("the sign-up form's", scriptHref({ handle: "harbor", productId: null, place: "" }), "https://marktmorgen.com/embed/harbor/join?mm=page&utm_source=website&utm_medium=checkout-script");
  const code = scriptCode({ handle: "harbor", productId: "k3j9x2p1ab", place: "blog", text: '</a><script>alert(1)</script>', mode: "overlay", fill: "#4f2acc", onFill: "#ffffff" });
  is("what the creator typed cannot leave the link", [code.includes("<script>alert"), code.split("<script>").length - 1], [false, 1]);
  is("the link says how it opens and asks for the site's origin only", /^<a href="https:\/\/marktmorgen\.com\/embed\/harbor\/k3j9x2p1ab\?mm=page&amp;[^"]+" data-mm="overlay" referrerpolicy="origin" style="[^"]*background:#4f2acc;color:#ffffff[^"]*">/.test(code), true);
  is("a color that is not one never reaches the style", scriptCode({ handle: "h", productId: "abcdef", place: "", text: "Buy", mode: "page", fill: "red;background:url(x)", onFill: "#fff" }).includes("url(x)"), false);
  is("and the script follows, exactly as its hash was made", code.endsWith(`\n${loaderTag()}`) && loaderTag() === `<script>${loaderSource()}</script>`, true);
  is("no key, no secret, no store record in it", /nl_live|sk_|secret|statsId/i.test(code), false);

  part("The script, as it reads and runs");
  const source = loaderSource();
  is("it reads no cookie, no storage, and fetches nothing", /cookie|localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|sendBeacon|querySelector|innerHTML|eval\(/.test(source), false);
  is("its purchase mark is the receipt's", source.includes(PURCHASE_MARK_PATTERN.source.replace(/\//g, "\\/")), true);
  const node = createHash("sha256").update(source).digest("base64");
  is("its hash, the same in a browser and on the server", await loaderHash(), `'sha256-${node}'`);
  is("and the policy lines a site adds", cspLines(await loaderHash()), [`script-src 'sha256-${node}'`, "frame-src https://marktmorgen.com"]);

  const page = standIn();
  is("nothing is touched on load", page.touched, []);
  is("one global, with its version", (page.window.Marktmorgen as { version: number }).version, 2);
  is("a click on any other link is left alone", [page.click(page.link("https://example.com/", "overlay")), page.click(page.link("https://marktmorgen.com/@harbor", "overlay")), page.appended.length], [false, false, 0]);
  is("so is a click with a key held, for a new tab", [page.click(page.link("https://marktmorgen.com/embed/harbor/k3j9x2p1ab?mm=page", "overlay"), { metaKey: true }), page.appended.length], [false, 0]);
  const pageLink = page.link("https://marktmorgen.com/embed/harbor/k3j9x2p1ab?mm=page", "page");
  is("a link that opens a page is followed, and says it was pressed", [page.click(pageLink), page.appended.length, page.fired.at(-1)?.type], [false, 0, "marktmorgen:open"]);

  const buy = page.link("https://marktmorgen.com/embed/harbor/k3j9x2p1ab?mm=page&utm_source=blog", "overlay", "Buy The Reset");
  is("a link that opens over the page is held back", page.click(buy), true);
  const box = page.appended[0] as { attributes: Record<string, string>; children: Record<string, unknown>[] };
  const frame = box?.children[0] as { src: string; referrerPolicy: string; title: string; contentWindow: unknown; style: { height?: string } };
  is("and opens one dialog, named by the link, with a frame and a close button", [page.appended.length, box.attributes.role, box.attributes["aria-modal"], box.attributes["aria-label"], box.children.length], [1, "dialog", "true", "Buy The Reset", 2]);
  is("the frame is the card, over the page, asking for the site's origin only", [frame.src, frame.referrerPolicy], ["https://marktmorgen.com/embed/harbor/k3j9x2p1ab?mm=overlay&utm_source=blog", "origin"]);
  // The keyboard stays in the dialog (2.4.3, 2.4.11): the browser's own modal dialog makes the rest of the page unreachable
  // until it closes, without the script reading or changing any element of the page.
  is("the dialog is the browser's own modal one", [(box as unknown as { tag: string }).tag, (box as unknown as { modal?: boolean }).modal], ["dialog", true]);
  is("the card's frame takes the focus as the dialog opens", page.document.activeElement === frame, true);
  (frame as unknown as { onload?: (() => void) | null }).onload?.();
  // contentWindow.focus() focuses the card's window, not one of its controls: the next Tab reaches the first of them.
  is("once the card has loaded, the focus is in its window, so the next Tab reaches the card's first control", (frame.contentWindow as { focused?: boolean }).focused, true);
  const shut = box.children[1] as { tag: string; style: Record<string, string>; onfocus?: () => void; onblur?: () => void; focus: () => void };
  // The card loads again when it moves within its frame (a call's times, a form sent): the person may be on Close by then.
  (frame.contentWindow as { focused?: boolean }).focused = false;
  shut.focus();
  (frame as unknown as { onload?: (() => void) | null }).onload?.();
  is("a later load of the card never takes the focus back from where the person is (3.2.1, 3.2.5)", [(frame.contentWindow as { focused?: boolean }).focused ?? false, page.document.activeElement === shut], [false, true]);
  const late = standIn();
  late.click(late.link("https://marktmorgen.com/embed/harbor/k3j9x2p1ab?mm=page", "overlay", "Buy The Reset"));
  const lateParts = (late.appended[0] as { children: Record<string, unknown>[] }).children;
  const lateFrame = lateParts[0] as { contentWindow: { focused?: boolean }; onload?: (() => void) | null };
  (lateParts[1] as { focus: () => void }).focus();
  lateFrame.onload?.();
  is("nor does a card that loads after the person has already moved on to Close", [lateFrame.contentWindow.focused ?? false, late.document.activeElement === lateParts[1]], [false, true]);
  shut.onfocus?.();
  is("its close button shows its focus in two colors, 3 px each, seen on any page under it (2.4.13)", [shut.tag, shut.style.boxShadow], ["button", "0 0 0 3px #15112e,0 0 0 6px #fff"]);
  // Forced colors (high contrast) drop box-shadow: an outline, transparent elsewhere, is what shows the focus there (2.4.7, 2.4.13).
  is("with an outline too, which forced colors paint in the system's color", /^\d+px solid transparent$/.test(shut.style.outline ?? ""), true);
  is("never the browser's own outline taken away for good", shut.style.cssText.includes("outline:none"), false);
  shut.onblur?.();
  is("and only while it has the focus", [shut.style.boxShadow, shut.style.outline ?? ""], ["none", ""]);
  is("the page under it stops scrolling", (page.document.documentElement as { style: { overflow: string } }).style.overflow, "hidden");
  is("a second press opens no second frame", [page.click(buy), page.appended.length], [true, 1]);
  const before = page.fired.length;
  page.message({ marktmorgen: 1, type: "checkout" }, "https://evil.example.net", frame.contentWindow);
  page.message({ marktmorgen: 1, type: "checkout" }, "https://marktmorgen.com", { other: true });
  page.message({ type: "checkout" }, "https://marktmorgen.com", frame.contentWindow);
  page.message({ marktmorgen: 1, type: "steal" }, "https://marktmorgen.com", frame.contentWindow);
  is("a message from another origin, another frame, of another shape or kind is ignored", page.fired.length, before);
  page.message({ marktmorgen: 1, type: "ready", height: 260, extra: "x" }, "https://marktmorgen.com", frame.contentWindow);
  is("ready: an event on the link, with only the known fields, and the frame takes its height", [page.fired.at(-1), frame.style.height], [{ type: "marktmorgen:ready", detail: { kind: "product", handle: "harbor", product: "k3j9x2p1ab", mode: "overlay" }, on: "link" }, "260px"]);
  page.message({ marktmorgen: 1, type: "ready", height: 99999 }, "https://marktmorgen.com", frame.contentWindow);
  is("never a height that makes no sense", frame.style.height, "260px");
  page.message({ marktmorgen: 1, type: "checkout" }, "https://marktmorgen.com", frame.contentWindow);
  is("checkout: said, and the overlay closes, giving the page back", [page.fired.at(-2)?.type, page.fired.at(-1)?.type, (page.fired.at(-1)?.detail as { reason: string }).reason, page.appended.length, (page.document.documentElement as { style: { overflow: string } }).style.overflow], ["marktmorgen:checkout", "marktmorgen:close", "checkout", 0, ""]);

  const join = page.link("https://marktmorgen.com/embed/harbor/join?mm=page", "overlay", "Join");
  page.click(join);
  const joinFrame = (page.appended[0] as { children: { contentWindow: unknown }[] }).children[0];
  page.message({ marktmorgen: 1, type: "optin", status: "sent" }, "https://marktmorgen.com", joinFrame.contentWindow);
  is("the form: optin, with what happened", page.fired.at(-1)?.detail, { kind: "optin", handle: "harbor", product: null, mode: "overlay", status: "sent" });
  page.message({ marktmorgen: 1, type: "optin", status: "<img src=x>" }, "https://marktmorgen.com", joinFrame.contentWindow);
  is("a status of another shape is left out", (page.fired.at(-1)?.detail as { status?: string }).status, undefined);
  page.key("Escape");
  is("Escape closes it", [page.appended.length, (page.fired.at(-1)?.detail as { reason: string }).reason], [0, "escape"]);
  page.click(join);
  let held = false;
  (page.appended[0] as unknown as { oncancel?: (event: { preventDefault: () => void }) => void }).oncancel?.({ preventDefault: () => (held = true) });
  is("the browser's own Escape on the dialog closes it the same way, never leaving it shown but not modal", [held, page.appended.length, (page.fired.at(-1)?.detail as { reason: string }).reason], [true, 0, "escape"]);
  is("and still nothing was read from the page", page.touched, []);

  const order = eventIdFor("0123456789abcdef0123456789abcdef", "sale.completed", "cs_test_123");
  const back = purchaseReturn("https://www.example.com/thanks?a=1#old", "k3j9x2p1ab", order);
  is("the receipt's way back carries the product and the order's webhook id", back, `https://www.example.com/thanks?a=1#mm-purchase=k3j9x2p1ab.${order}`);
  is("never with a product or an order of another shape", [purchaseReturn("https://x.example.com/", "../x", order), purchaseReturn("https://x.example.com/", "k3j9x2p1ab", "cs_live_x")], [null, null]);
  const returned = standIn(`#mm-purchase=k3j9x2p1ab.${order}`);
  for (const run of returned.timers) run();
  is("back on the page, the script says the purchase and takes the mark off the address", [returned.fired.at(-1), returned.replaced(), (returned.window.Marktmorgen as { purchase: unknown }).purchase], [{ type: "marktmorgen:purchase", detail: { product: "k3j9x2p1ab", order }, on: "document" }, "/thank-you?a=1", { product: "k3j9x2p1ab", order }]);
  const forged = standIn("#mm-purchase=<b>.evt_x");
  for (const run of forged.timers) run();
  is("a mark of another shape says nothing", forged.fired.length, 0);

  part("The frame pages");
  is("the card and the form are the pages that may be framed, with their nonce", [isEmbedPage("/embed/harbor/join"), isDynamicPage("/embed/harbor/join"), isEmbedPage("/embed/harbor/join/x")], [true, true, false]);
  const card = read("app/embed/[handle]/[product]/page.tsx");
  const form = read("app/embed/[handle]/join/page.tsx");
  const opener = read("lib/embed-open.ts");
  // TODOS-51 (owner, 9 November 2026): an open is read on the server, but its visit is counted only by the page
  // itself, through the host's browser check (app/api/store/hit); the server never counts it, since any program can ask.
  is("an open by the script is read on the server, and its visit is counted by the page, never there", [/readScriptOpen\(store, mode, query\)/.test(card), /readScriptOpen\(store, mode, query\)/.test(form), /recordVisit|countVisit|after\(/.test(opener), /open \? <StoreBeacon handle=\{store\.handle\} front=\{false\} \/> : null/.test(card), /<StoreBeacon handle=\{store\.handle\} front=\{false\} \/>/.test(form)], [true, true, false, true, true]);
  is("it rests with the store, and is limited per connection", [/isResting\(store\)/.test(opener), /withinLimit\("embed-open"/.test(opener)], [true, true]);
  is("a frame on an unlisted site buys nothing", /if \(mode === "overlay" && !site\) return \{ \.\.\.base, live: false, reason: "site" \}/.test(opener), true);
  is("the card messages only a listed site, while it can buy", /const messaging = open\?\.mode === "overlay" && open\.live && open\.site \? open\.site : null;/.test(card), true);
  is("the form, the same", /const talking = framed && open\.live && open\.site \? open\.site : null;/.test(form), true);
  is("a plain link when it may not buy, or carries an affiliate's code", /const plain = open \? !open\.live \|\| Boolean\(open\.via\) : !\(await pastedAllowed\(store\)\);/.test(card), true);
  const messenger = read("components/embed-messenger.tsx");
  is("the frame messages one origin and listens to no message", [/postMessage\(\{ marktmorgen: 1, type, \.\.\.more \}, to\)/.test(messenger), /addEventListener\("message"/.test(messenger)], [true, false]);
  is("as a page, the checkout stays in the tab; in a frame, a new one", [/target="_top" className="mt-3" data-checkout=""/.test(card), /target="_blank" rel="noopener" className="mt-3" data-checkout=""/.test(card)], [true, true]);

  part("The checkout, the sign-up and the receipt check the site again");
  const checkout = read("app/api/store/checkout/route.ts");
  is("the checkout keeps a site only from the store's list", /embedSite: listedReturn\(store\.embedSites, returnAsked\) \?\? listedSite\(store\.embedSites, siteAsked\) \?\? undefined/.test(checkout), true);
  const builder = read("lib/store-checkout.ts");
  is("and writes it only while Stripe's metadata has room", /filter\(\(key\) => key\.startsWith\("metadata\["\)\)\.length < 49/.test(builder), true);
  const joinRoute = read("app/api/store/join/route.ts");
  is("the sign-up answers on the form's own page, with listed sites only", [/listedSite\(store\.embedSites, siteAsked\)/.test(joinRoute), /listedReturn\(store\.embedSites, returnAsked\)/.test(joinRoute)], [true, true]);
  const thanks = read("app/[handle]/thanks/page.tsx");
  is("the receipt sends back only to a site still listed", /listedReturn\(store\.embedSites, embedMeta\) \?\? listedSite\(store\.embedSites, embedMeta\)/.test(thanks), true);

  part("Webhooks");
  is("list.joined is an event", (WEBHOOK_EVENTS as readonly string[]).includes("list.joined"), true);
  is("and is sent when an address is confirmed", /emitEvent\(store, "list\.joined"/.test(read("app/api/store/join/confirm/route.ts")), true);
  is("the studio lists it", /key: "list\.joined"/.test(read("components/webhook-editor.tsx")), true);
  is(
    "sale.completed says where the sale came from",
    sourceOf({ utm_source: "blog", utm_medium: "checkout-script", embed_site: "https://www.example.com/thanks?a=1" }),
    { utm_source: "blog", utm_medium: "checkout-script", utm_campaign: null, utm_content: null, site: "https://www.example.com" },
  );
  is("and nothing when the order carries nothing", sourceOf({}), { utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, site: null });

  part("What is published about it");
  const docs = read("app/developers/checkout-script/page.tsx");
  is("the public page prints the script and its policy from the code", [/loaderSource\(\)/.test(docs), /cspLines\(hash\)/.test(docs), /MAX_EMBED_SITES/.test(docs), /OPENS_PER_TEN_MINUTES/.test(docs)], [true, true, true, true]);
  is("and never promises without a number", /unlimited/i.test(docs + read("components/checkout-script-editor.tsx") + read("lib/embed-sdk.ts")), false);

  done();
}

void main();
