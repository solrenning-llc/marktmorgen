/**
 * The checkout script: what a creator pastes into any website of theirs so a
 * link there opens their product's checkout card, or their sign-up form, over
 * the page, and the page hears what happened (added 17 October 2026).
 *
 * What is pasted is a plain link and a short script, both written into the
 * creator's own page:
 *
 *   <a href="https://marktmorgen.com/embed/<store>/<product>?mm=page&…" data-mm="overlay" referrerpolicy="origin">Buy it</a>
 *   <script>…LOADER…</script>
 *
 * Why the script is written into the page rather than loaded from here: a
 * script tag pointing at this site would be fetched on every view of every
 * page that holds it, read or not, and that transfer is a cost nobody's plan
 * measures. Written into the page, a view of it costs this site nothing at
 * all. Something is asked of this site only when a visitor presses the link,
 * and then it is the same card the store's own pages draw, read once and
 * counted as a visit to the store (lib/traffic.ts): a store past the visits
 * its plan covers shows the plain link instead, like its other pages rest.
 * The script is the same for every store and every product (they are in the
 * link), so one sha256 hash allows it under a Content-Security-Policy.
 *
 * What the script does, and the whole of what it reads:
 *
 *   - It listens for clicks on links that carry data-mm and point at this
 *     site's /embed/ addresses, and reads that link's own address, its
 *     data-mm and its text (for the dialog's name). Nothing else on the page:
 *     no field, no cookie, no storage, no other element.
 *   - data-mm="overlay": the card (or form) opens in a frame over the page,
 *     with a close button, closed by Escape or a click beside it. A buyer
 *     who presses its buy button pays on Stripe's page in a new tab, on the
 *     creator's own Stripe account (lib/stripe-connect.ts): the money never
 *     passes through Marktmorgen.
 *   - data-mm="page", or no script at all: the link is followed, and the
 *     card is a page of its own; its buy button goes to Stripe in that tab.
 *   - It turns the frame's messages into events on the page: a message is
 *     taken only from this site's origin and from the frame it opened
 *     (lib/embed-sites.ts lists them), and only the fields named below.
 *   - It reads the page's address fragment once, for the mark the receipt
 *     page adds when it sends a buyer back (#mm-purchase=…), says
 *     "marktmorgen:purchase" and takes the mark off the address.
 *
 * The events, all on the link (and so on document) except the purchase,
 * which is on document, each with `detail`:
 *
 *   marktmorgen:open      { kind, handle, product, mode }   the link was pressed
 *   marktmorgen:ready     { … }                             the card or form is showing
 *   marktmorgen:checkout  { … }                             the buy button was pressed
 *   marktmorgen:optin     { …, status }                     the form was sent: "sent" is a confirmation email on its way
 *   marktmorgen:close     { …, reason }                     the overlay closed
 *   marktmorgen:purchase  { product, order }                back from paying; `order` is the sale.completed webhook's id
 *
 * They are for what the page shows. Anybody can make a page say them, so
 * nothing is handed over because of one: what was paid is told to the
 * creator's server by the signed sale.completed webhook (lib/webhooks.ts).
 *
 * Browser-safe: the studio builds the code with these.
 */
import { SITE_URL } from "./site-url";
import { escapeHtml } from "./embed-rules";
import { type ScriptMode, SCRIPT_MEDIUM, withTags } from "./embed-sites";
import { contrast } from "./store-look";

/** Which version of the script this is; a change to it is a new version, and the old one keeps working. */
export const SCRIPT_VERSION = 1;

/**
 * The script, exactly as it is pasted. One line per statement group, so a
 * creator who reads it can follow it; it must not change by a single byte
 * without a new version, because its hash is what a site's policy allows.
 */
export function loaderSource(origin = SITE_URL): string {
  return [
    `/* Marktmorgen checkout script v${SCRIPT_VERSION}. What it does: ${origin}/developers/checkout-script */`,
    "(function(w,d){",
    "if(w.Marktmorgen)return;",
    `var O=${JSON.stringify(origin)},open=null,api={version:${SCRIPT_VERSION},purchase:null,close:function(){shut("page")}};`,
    "w.Marktmorgen=api;",
    "function copy(a,b){var c={},k;for(k in a)c[k]=a[k];for(k in b)c[k]=b[k];return c}",
    'function fire(t,detail,el){var e;try{e=new CustomEvent("marktmorgen:"+t,{detail:detail,bubbles:true})}catch(x){return}(el&&el.isConnected?el:d).dispatchEvent(e)}',
    'function key(e){if(e.key==="Escape")shut("escape")}',
    'function shut(why){if(!open)return;var o=open;open=null;w.removeEventListener("message",hear);d.removeEventListener("keydown",key,true);if(o.box.parentNode)o.box.parentNode.removeChild(o.box);d.documentElement.style.overflow=o.over;try{o.el.focus()}catch(x){}fire("close",copy(o.info,{reason:why}),o.el)}',
    "function hear(e){if(!open||e.origin!==O||e.source!==open.frame.contentWindow)return;var m=e.data;" +
      'if(!m||m.marktmorgen!==1||typeof m.type!=="string")return;' +
      'if(m.type==="close")return shut("frame");' +
      'if(m.type==="ready"){var h=Number(m.height);if(h>=160&&h<=800)open.frame.style.height=h+"px"}' +
      'if(m.type!=="ready"&&m.type!=="checkout"&&m.type!=="optin")return;' +
      'var more={};if(typeof m.status==="string"&&/^[a-z_]{1,20}$/.test(m.status))more.status=m.status;' +
      'fire(m.type,copy(open.info,more),open.el);if(m.type==="checkout")shut("checkout")}',
    'd.addEventListener("click",function(e){',
    "if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;",
    'var a=e.target&&e.target.closest?e.target.closest("a[data-mm]"):null;if(!a)return;',
    "var u;try{u=new URL(a.href)}catch(x){return}var p=u.pathname.split(\"/\");",
    'if(u.origin!==O||p[1]!=="embed"||!p[2]||!p[3])return;',
    'var join=p[3]==="join",info={kind:join?"optin":"product",handle:decodeURIComponent(p[2]),product:join?null:p[3],mode:a.getAttribute("data-mm")==="page"?"page":"overlay"};',
    'if(info.mode==="page"){fire("open",info,a);return}',
    'e.preventDefault();if(open)return;fire("open",info,a);u.searchParams.set("mm","overlay");',
    'var box=d.createElement("div"),frame=d.createElement("iframe"),x=d.createElement("button"),name=(a.textContent||"").trim().slice(0,80)||"Checkout";',
    'box.setAttribute("role","dialog");box.setAttribute("aria-modal","true");box.setAttribute("aria-label",name);',
    'box.style.cssText="position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:72px 16px 16px;background:rgba(17,14,36,.6)";',
    'frame.src=u.href;frame.title=name;frame.referrerPolicy="origin";',
    'frame.style.cssText="display:block;width:100%;max-width:400px;height:420px;max-height:calc(100vh - 96px);border:0;border-radius:24px;background:transparent";',
    'x.type="button";x.setAttribute("aria-label","Close");x.textContent="\\u00d7";',
    'x.style.cssText="position:absolute;top:16px;right:16px;width:44px;height:44px;border:0;border-radius:999px;background:#fff;color:#15112e;font:600 26px/1 system-ui,sans-serif;cursor:pointer";',
    'x.onclick=function(){shut("button")};box.onclick=function(ev){if(ev.target===box)shut("backdrop")};',
    "box.appendChild(frame);box.appendChild(x);",
    "open={box:box,frame:frame,el:a,info:info,over:d.documentElement.style.overflow};",
    'd.documentElement.style.overflow="hidden";w.addEventListener("message",hear);d.addEventListener("keydown",key,true);d.body.appendChild(box);frame.focus()',
    "});",
    "var mark=/^#mm-purchase=([a-z0-9]{6,40})\\.(evt_[0-9a-f]{32})$/.exec(w.location.hash);",
    'if(mark){api.purchase={product:mark[1],order:mark[2]};try{history.replaceState(history.state,"",w.location.pathname+w.location.search)}catch(x){}',
    'var say=function(){fire("purchase",api.purchase)};if(d.readyState==="loading")d.addEventListener("DOMContentLoaded",say);else setTimeout(say,0)}',
    "})(window,document);",
  ].join("\n");
}

/** The script as a tag, exactly as pasted: nothing between the tags but the script, so its hash matches. */
export function loaderTag(origin = SITE_URL): string {
  return `<script>${loaderSource(origin)}</script>`;
}

/** Its sha256, as a Content-Security-Policy source ('sha256-…'). Works in a browser and on the server. */
export async function loaderHash(origin = SITE_URL): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(loaderSource(origin)));
  let text = "";
  for (const byte of new Uint8Array(digest)) text += String.fromCharCode(byte);
  return `'sha256-${btoa(text)}'`;
}

/** The longest text on the link. */
export const MAX_LINK_TEXT = 60;

/** The link's look, the same as the plain button's (lib/embed-rules.ts buttonStyle), written into its style attribute. */
function styleText(fill: string, onFill: string): string {
  const safe = (colour: string, fallback: string) => (/^#[0-9a-f]{6}$/i.test(colour) ? colour : fallback);
  const background = safe(fill, "#15112e");
  const foreground = safe(onFill, "#ffffff");
  // This 16px label needs 7:1 (WCAG 1.4.6). Preserve readable choices;
  // otherwise use the existing default pair, without changing the loader.
  const [readableFill, readableText] = contrast(background, foreground) >= 7 ? [background, foreground] : ["#15112e", "#ffffff"];
  return [
    "display:inline-block",
    "padding:14px 28px",
    "border-radius:999px",
    `background:${readableFill}`,
    `color:${readableText}`,
    "font:600 16px/1.25 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    "text-decoration:none",
  ].join(";");
}

/** The address a script link points at: the product's card (or the store's sign-up form) as a page of its own, tagged. */
export function scriptHref({
  handle,
  productId,
  place,
  campaign,
  back,
  via,
  origin = SITE_URL,
}: {
  handle: string;
  /** null for the sign-up form. */
  productId: string | null;
  place: string;
  campaign?: string;
  /** Where to send the buyer back to, on one of the store's listed sites (lib/embed-sites.ts listedReturn checks it again). */
  back?: string;
  /** An affiliate's code, for a link an affiliate puts on their own site. */
  via?: string;
  origin?: string;
}): string {
  const path = `${origin}/embed/${encodeURIComponent(handle)}/${productId ? encodeURIComponent(productId) : "join"}`;
  return withTags(
    `${path}?mm=page`,
    { utm_source: place || "website", utm_medium: SCRIPT_MEDIUM, utm_campaign: campaign ?? "" },
    { return: back || null, via: via || null },
  );
}

/** The link, with the script under it: what the studio gives to paste. */
export function scriptCode(input: Parameters<typeof scriptHref>[0] & { text: string; mode: ScriptMode; fill: string; onFill: string; withScript?: boolean }): string {
  const text = input.text.replace(/\s+/g, " ").trim().slice(0, MAX_LINK_TEXT) || (input.productId ? "Buy now" : "Join the list");
  const link =
    `<a href="${escapeHtml(scriptHref(input))}" data-mm="${input.mode}" referrerpolicy="origin" ` +
    `style="${escapeHtml(`${styleText(input.fill, input.onFill)};`)}">${escapeHtml(text)}</a>`;
  return input.withScript === false ? link : `${link}\n${loaderTag(input.origin)}`;
}

/**
 * Where each kind of site takes pasted code, and what its policy needs.
 *
 * Only what is known to hold: where each takes pasted code, and that
 * WordPress itself sends no Content-Security-Policy. A site that does send
 * one needs the same two lines whatever built it (cspLines). The builders
 * that run pasted code in a frame of their own, on an address of their own,
 * are said to: there the overlay opens inside that box and the site this
 * sees is the builder's, so the link that opens a page is the one to use.
 */
export const BUILDERS: { name: string; where: string; policy: string }[] = [
  {
    name: "Your own HTML",
    where: "Paste the link where it should show and the script once, anywhere in the page (before </body> is usual).",
    policy: "If your server sends a Content-Security-Policy header, add the lines below to it.",
  },
  {
    name: "WordPress",
    where: "In the block editor, add a Custom HTML block and paste both. The script can sit in the same block as the first link.",
    policy: "WordPress sends no policy of its own. If a security plugin adds one, add the lines below in that plugin's settings.",
  },
  {
    name: "Webflow",
    where: "Add a Code Embed element where the link goes and paste both, or put the script in the page's custom code, before </body>.",
    policy: "If your site sends a policy, add the lines below to it.",
  },
  {
    name: "Squarespace",
    where: "Add a Code block and paste both, with Display Source off.",
    policy: "If your site sends a policy, add the lines below to it.",
  },
  {
    name: "Ghost",
    where: "In a post or page, add an HTML card and paste both.",
    policy: "If your site sends a policy, add the lines below to it.",
  },
  {
    name: "Wix and other builders that frame pasted code",
    where: "An embed element there runs your code in a frame on the builder's own address, so the overlay would open inside that box. Use the link that opens a page instead (Opens: as a page), which works in any of them.",
    policy: "Nothing to add: a plain link needs no policy.",
  },
];

/** The lines a site's Content-Security-Policy needs for the script and its frame. */
export function cspLines(hash: string, origin = SITE_URL): string[] {
  return [`script-src ${hash}`, `frame-src ${origin}`];
}
