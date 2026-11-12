/**
 * Escape closes the checkout script's overlay whatever the frame shows (finding on the embed overlay, 12 November
 * 2026; WCAG 2.1.1 Keyboard, 2.1.2 No Keyboard Trap). The script (lib/embed-sdk.ts) puts the focus inside the frame,
 * so Escape is heard there and only the frame can say "close". It said so only while the card could buy: on a site the
 * creator did not list, on a resting store or past the open limit, the frame showed the plain link and Escape did
 * nothing. Now:
 *
 * - closeTarget gives the one origin a frame may tell of Escape: the listed site, else the https origin of the page
 *   that framed it (the script sends its Referer as an origin); never a page of this site, never one in page mode,
 *   never a Referer that does not read;
 * - the card and the sign-up form draw a close-only messenger wherever they draw no full one, and the close-only
 *   messenger says nothing but "close", on Escape: no ready, no checkout, no sign-up answer;
 * - the card's page title for a product no longer on sale is in the store's words, as its sentence is, and stays
 *   English only where no store could be read.
 */
import { readFileSync } from "node:fs";
import { closeTarget } from "@/lib/embed-open";
import { generateMetadata } from "@/app/embed/[handle]/[product]/page";
import { claimHandle, setLanguage } from "@/lib/store";
import { speech } from "@/lib/buyer-words";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const HOST = "marktmorgen.com";

part("The one origin a frame may tell of Escape");
is("a listed site", closeTarget("overlay", "https://listed.example", "https://listed.example/", HOST), "https://listed.example");
is("a site the creator did not list: the page that framed it, as an origin", closeTarget("overlay", null, "https://other.example/shop?x=1", HOST), "https://other.example");
is("a page of this site (the studio preview): nobody", closeTarget("overlay", null, "https://marktmorgen.com/studio", HOST), null);
is("the host this request was sent to: nobody", closeTarget("overlay", null, "https://marktmorgen.com/x", "marktmorgen.com"), null);
is("no Referer: nobody", closeTarget("overlay", null, null, HOST), null);
is("a Referer that does not read: nobody", closeTarget("overlay", null, "not a url", HOST), null);
is("a page that is not https: nobody", closeTarget("overlay", null, "http://plain.example/", HOST), null);
is("page mode, never a frame: nobody", closeTarget("page", null, "https://other.example/", HOST), null);
is("page mode on a listed site: nobody", closeTarget("page", "https://listed.example", "https://listed.example/", HOST), null);

part("The card and the form draw a close-only messenger where they draw no full one");
const card = readFileSync("app/embed/[handle]/[product]/page.tsx", "utf8");
const form = readFileSync("app/embed/[handle]/join/page.tsx", "utf8");
is("the card", /messaging \? <EmbedMessenger to=\{messaging\} height=\{height\} \/> : open\?\.closeTo \? <EmbedMessenger to=\{open\.closeTo\} closeOnly \/> : null/.test(card), true);
is("the card's not-on-sale frame too", /open\?\.closeTo \? <EmbedMessenger to=\{open\.closeTo\} closeOnly \/> : null[\s\S]*?const selling = canSell/.test(card), true);
is("the form, in its three places (the answer, the plain link, the form)", (form.match(/: open\.closeTo && framed \? <EmbedMessenger to=\{open\.closeTo\} closeOnly \/> : null/g) ?? []).length, 3);

part("The close-only messenger says nothing but close");
const messenger = readFileSync("components/embed-messenger.tsx", "utf8");
const effect = messenger.slice(messenger.indexOf("useEffect("));
is("it takes closeOnly", /closeOnly\?: boolean/.test(messenger), true);
is("ready and the sign-up answer are said only without it", /if \(!closeOnly\) \{\s*say\("ready"/.test(effect), true);
is("checkout is said only without it", /if \(!closeOnly && form instanceof HTMLFormElement/.test(effect), true);
is("Escape says close either way", /if \(event\.key === "Escape"\) say\("close"\)/.test(effect), true);

async function titles(): Promise<void> {
  part("The card's page title, in the store's words");
  redis.clear();
  await claimHandle("titles@example.com", "titelhaus", "Titelhaus", "");
  await setLanguage("titles@example.com", "de");
  const gone = await generateMetadata({ params: Promise.resolve({ handle: "titelhaus", product: "nosuchproduct1" }) } as never);
  const words = speech({ language: "de" } as never).w.noLongerOnSale.replace(/[.!?]$/, "");
  is("a product no longer on sale: the store's German, with the store's name", gone.title, `${words} — Titelhaus`);
  const none = await generateMetadata({ params: Promise.resolve({ handle: "nosuchstore", product: "nosuchproduct1" }) } as never);
  is("no store: English, as the page", none.title, "Not on sale");
  done();
}

titles().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
