/**
 * 568 [GD2] (c), unit 1: a product or a sales page that poses as Marktmorgen itself is not published.
 *
 * The Terms give a creator no right to use our name except to identify the Services (section 10) and forbid
 * anything that misleads a buyer ("What you may not sell"). Words that read as Marktmorgen's sign-in, its account
 * or its staff, and addresses made to look like marktmorgen.com, are how a buyer is tricked into handing over a
 * sign-in or a card. Checked here:
 *
 *   - the rule alone (lib/brand-imitation-rules.ts): each way of posing is stopped; saying where the store runs,
 *     naming Marktmorgen's support, thanking its team, the protective opposite ("never asks for your password")
 *     and marktmorgen.com's own addresses are not; look-alike letters are read as what they imitate;
 *   - the real routes, on the in-memory database with a real session: adding a product that poses is refused with
 *     "brand_imitation", the passage, why and the fix, and nothing is added; a published product's page with such
 *     words or a look-alike link is refused and not written; publishing a draft that poses is refused; plain words
 *     pass every time;
 *   - both editors show it with the same sentence as the other refusals (fastMoneyMessage).
 *
 * Synthetic store and data only.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { readAllListings } from "@/lib/catalog";
import { readPage } from "@/lib/sales-page-store";
import { IMITATION_FIX, IMITATION_WHY, brandImitation, brandImitationOnPage, imitationIn, lookalikeHost, pageLinks } from "@/lib/brand-imitation-rules";
import { fastMoneyMessage } from "@/lib/terms-check-rules";
import { POST as productRoute } from "@/app/api/store/product/route";
import { POST as savePage } from "@/app/api/store/page/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ORIGIN = "https://marktmorgen.com";
const OWNER = "posing.check@example.com";

async function main(): Promise<void> {
  part("Posing as Marktmorgen is stopped");
  const stopped = [
    "Marktmorgen Support: your download is ready, sign in below.",
    "Regards, The Marktmorgen Team",
    "Thanks,\nMarktmorgen security team",
    "— The Marktmorgen Team",
    "We at Marktmorgen picked this course for you.",
    "This is Marktmorgen checkout, enter your card below.",
    "An official Marktmorgen bundle.",
    "Markt-Morgen official partner pack.",
    "Your Marktmorgen account has been suspended until you verify it.",
    "Verify your account with Marktmorgen to keep your purchases.",
    "Verify your Marktmorgen account to unlock it.",
    "Enter your Marktmorgen password to open the course.",
    "Unusual activity on your MARKTMORGEN library: click here.",
    "Download it at https://marktmorgen-login.com/files",
    "Get it at marktmorgen.com.pay-now.io/start",
    "Mirror: rnarktmorgen.com/library",
    "Write to help@marktmorgen-help.com for access.",
    "Visit https://Marktmorgen-Support.net today",
  ];
  is("each way of posing is found", stopped.map((text) => imitationIn(text) !== null), stopped.map(() => true));

  part("Saying where the store runs, and the protective opposite, are not");
  const passed = [
    "Sold on Marktmorgen.",
    "Marktmorgen emails you a link to your library after you pay.",
    "Log in to your library with the link Marktmorgen sends you.",
    "If a download fails, contact Marktmorgen support.",
    "Thanks to the Marktmorgen team for the course tools.",
    "Marktmorgen will never ask for your password.",
    "This is not an official Marktmorgen product.",
    "No one from Marktmorgen will ask you to verify your account.",
    "My store: marktmorgen.com/@ada and https://www.marktmorgen.com/help",
    "Built with Marktmorgen.Thanks for reading.",
    "A password manager course for families.",
    "Your account has been suspended? Here is how to appeal on any platform.",
    "Morgen, the market, sold here.",
  ];
  is("none of these is found", passed.map((text) => imitationIn(text)), passed.map(() => null));
  is("look-alike hosts and our own", [lookalikeHost("marktmorgen.com"), lookalikeHost("www.marktmorgen.com"), lookalikeHost("help.marktmorgen.com"), lookalikeHost("marktmorgen.co"), lookalikeHost("rnarktm0rgen.com"), lookalikeHost("example.com")], [false, false, false, true, true, false]);
  is("anything not text is nothing found", [imitationIn(null), imitationIn(42), imitationIn("")], [null, null, null]);

  part("A refusal says where, why and how to fix it");
  const refused = brandImitation({ title: "Night recipes", summary: "", about: "Regards, The Marktmorgen Team" });
  is("found in the description, with the passage, why and the fix", [refused?.field, refused?.excerpt.includes("Marktmorgen Team"), refused?.why, refused?.fix], ["about", true, IMITATION_WHY, IMITATION_FIX]);
  is("plain product words pass", brandImitation({ title: "Night recipes", summary: "Ten dinners.", about: "Sold on Marktmorgen." }), null);
  const page = { blocks: [{ id: "quote001", kind: "quotes", heading: "Said elsewhere", items: [{ text: "Great", name: "Ana", url: "https://marktmorgen-login.com/x" }] }] };
  is("a page's links are read", pageLinks(page), ["https://marktmorgen-login.com/x"]);
  is("a look-alike link on a page is found", brandImitationOnPage(["Great"], pageLinks(page))?.field, "page");
  is("our own address on a page is not", brandImitationOnPage(["Great"], ["https://marktmorgen.com/@ada"]), null);
  const said = fastMoneyMessage(refused, "add");
  is("the studio's sentence carries this why and fix, and that nothing was changed", [said.startsWith("It was not added."), said.includes(IMITATION_WHY), said.includes(IMITATION_FIX), /Nothing you wrote was changed/.test(said)], [true, true, true, true]);

  part("The real routes refuse it and write nothing");
  redis.clear();
  await claimHandle(OWNER, "posingcheck", "Posing Check", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const session = await openSession(OWNER);
  const post = (path: string, body: unknown) =>
    new NextRequest(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, host: "marktmorgen.com", "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify(body),
    });
  const answer = async (response: Response) => {
    const data = (await response.json().catch(() => ({}))) as { error?: string; passage?: { field?: string; why?: string } };
    return { status: response.status, error: data.error ?? "", field: data.passage?.field ?? "", why: data.passage?.why ?? "" };
  };
  const titles = async () => (await readAllListings((await storeForEmail(OWNER))!)).map((listing) => listing.title);

  const posing = await answer(await productRoute(post("/api/store/product", { action: "add", title: "Marktmorgen Support pack", price: "19" })));
  is("adding a product that poses is refused with the passage and why", [posing.status, posing.error, posing.field, posing.why], [409, "brand_imitation", "title", IMITATION_WHY]);
  is("and nothing is added", await titles(), []);
  const plain = await answer(await productRoute(post("/api/store/product", { action: "add", title: "Night recipes", price: "19", summary: "Sold on Marktmorgen." })));
  is("a plain product is added", [plain.status, await titles()], [200, ["Night recipes"]]);

  const store = (await storeForEmail(OWNER))!;
  const product = (await readAllListings(store))[0];
  const text = { id: "text0001", kind: "text", heading: "Why", body: "Because." };
  const pagePosing = await answer(await savePage(post("/api/store/page", { id: product.id, page: { blocks: [{ ...text, body: "Enter your Marktmorgen password to open it." }] } })));
  is("a published product's page that poses is refused", [pagePosing.status, pagePosing.error, pagePosing.field], [409, "brand_imitation", "page"]);
  const pageLink = await answer(await savePage(post("/api/store/page", { id: product.id, page: { blocks: [text, { id: "quote001", kind: "quotes", heading: "Said elsewhere", items: [{ text: "Great", name: "Ana", url: "https://marktmorgen-login.com/x" }] }] } })));
  is("so is one with a look-alike link", [pageLink.status, pageLink.error], [409, "brand_imitation"]);
  is("and no page was written", ((await readPage(store.statsId!, product.id).catch(() => null))?.blocks ?? []).length, 0);
  const pagePlain = await answer(await savePage(post("/api/store/page", { id: product.id, page: { blocks: [text] } })));
  is("a plain page is saved", pagePlain.status, 200);

  // A draft may hold the words; it is checked when it is published.
  const draft = await addProduct(OWNER, "Quiet draft", "Regards, The Marktmorgen Team", "9", null);
  if (!draft.ok) throw new Error("no draft");
  await productRoute(post("/api/store/product", { action: "visibility", id: draft.product.id, hidden: true }));
  const publish = await answer(await productRoute(post("/api/store/product", { action: "visibility", id: draft.product.id, hidden: false })));
  is("publishing a draft that poses is refused", [publish.status, publish.error, publish.field], [409, "brand_imitation", "summary"]);

  part("Both editors say it");
  is("the product editor", /data\.error === "fast_money" \|\| data\.error === "brand_imitation"\) return wrong\(fastMoneyMessage\(/.test(readFileSync("components/product-editor.tsx", "utf8")), true);
  is("the page editor", /data\.error === "brand_imitation" \? fastMoneyMessage\(/.test(readFileSync("components/page-editor.tsx", "utf8")), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
