import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { BUILDERS, SCRIPT_VERSION, cspLines, loaderHash, loaderSource, scriptCode } from "@/lib/embed-sdk";
import { MAX_EMBED_SITES, OPENS_PER_TEN_MINUTES, SCRIPT_MEDIUM } from "@/lib/embed-sites";
import { MAX_ENDPOINTS } from "@/lib/webhooks";

export const metadata: Metadata = {
  title: "Checkout script — Marktmorgen",
  description:
    "Sell from any website of yours: a link and a short script open your product's card or your sign-up form over your page, carry your utm tags, and tell your page and your webhooks what happened. What it does, exactly.",
};

/**
 * What the checkout script does, written from the code (lib/embed-sdk.ts,
 * lib/embed-sites.ts, lib/embed-open.ts) and nothing ahead of it. When the
 * script or its rules change, this page changes in the same commit.
 */
function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-[12px] bg-[#15112e] p-4 text-[0.8125rem] leading-relaxed text-[#ece9ff]">
      <code>{children}</code>
    </pre>
  );
}

const c = (text: string) => <code className="font-mono">{text}</code>;

export default async function CheckoutScriptPage() {
  const hash = await loaderHash();
  const example = scriptCode({
    handle: "harbor",
    productId: "k3j9x2p1ab",
    place: "blog",
    campaign: "spring-launch",
    back: "https://www.example.com/thank-you",
    text: "Buy The 7-Day Reset",
    mode: "overlay",
    fill: "#5a36ee",
    onFill: "#ffffff",
    withScript: false,
  });
  return (
    <LegalPage title="Checkout script" eyebrow="For your own website" effective={null} legalNav={false} lastUpdated="October 17, 2026">
      <p>
        Put a link on any page of your own site, on WordPress, Webflow, Squarespace, Ghost or plain HTML, and it opens your product&apos;s card, or
        your email list&apos;s sign-up form, over that page. Your buyer pays on Stripe&apos;s checkout page, on your own connected Stripe account:
        the money goes from your buyer to you and never passes through Marktmorgen. Your page is told what happened, and so are your{" "}
        <Link href="/help#can-i-connect-zapier-make-or-my-own-server" className="text-black underline underline-offset-2 hover:no-underline">
          webhooks
        </Link>
        . Every plan has it. Make the code in your studio, under Checkout on your own website.
      </p>

      <LegalSection title="What you paste">
        <p>A link, and once per page, the script. This is a link made in the studio:</p>
        <Code>{example}</Code>
        <p>
          The link works with or without the script: followed as it is, it opens the card as a page of its own, whose buy button goes on to
          Stripe in the same tab. With the script on the page and {c('data-mm="overlay"')}, it opens the card in a frame over your page instead,
          and Stripe&apos;s checkout opens in a new tab, so your page stays where it was. With {c('data-mm="page"')} the script lets the link be
          followed and only says it was pressed. A link to {c("/embed/<store>/join")} opens your sign-up form the same two ways.
        </p>
        <p>
          {`The address carries its own tags: utm_source is the place you name (website when you leave it empty), utm_medium is ${SCRIPT_MEDIUM}, and utm_campaign is yours if you give one. A sale made through it carries them to Stripe and to your numbers, where it is listed under Where the money came from. `}
          {c("return")} is the page the receipt sends the buyer back to; {c("via")} is an affiliate&apos;s code, for a link an affiliate puts on
          their own site, which opens your product&apos;s page so your store&apos;s affiliate and consent rules apply there as they do to any
          affiliate link. Product ids are in your studio, and in the API&apos;s{" "}
          <Link href="/developers#products" className="text-black underline underline-offset-2 hover:no-underline">
            products
          </Link>{" "}
          list.
        </p>
      </LegalSection>

      <LegalSection title="Your sites">
        <p>
          {`List up to ${MAX_EMBED_SITES} of your own sites in the studio, each an https address such as https://www.example.com. Only on those does the card or the form open over the page, with its buy button or its box, and only those are told what happened. On any other site, or when the browser sends no address of the page, the frame shows a plain link, in a new tab, to your product's page (or, for the form, your store's page), and tells nobody anything. The return page has to be on one of your sites too, so the receipt can never send somebody to an address you did not name.`}
        </p>
        <p>
          The frame knows which site it is on from the address the browser sends with it; the script asks for the site&apos;s origin only (
          {c('referrerpolicy="origin"')}), never the page&apos;s path, and a web page cannot write that header itself. Once you list a site, the
          cards you pasted with the frame code show the plain link anywhere else as well. Until you list one, those cards work wherever they are
          pasted, as before.
        </p>
      </LegalSection>

      <LegalSection title="Events on your page">
        <p>
          The script dispatches these on the link that was pressed, so they bubble up to {c("document")}. Each carries {c("detail")} with{" "}
          {c("kind")} ({c("product")} or {c("optin")}), {c("handle")}, {c("product")} (null for the form) and {c("mode")}:
        </p>
        <Code>{`marktmorgen:open      the link was pressed
marktmorgen:ready     the card or form is showing (over the page)
marktmorgen:checkout  the buy button was pressed; Stripe opens in a new tab
marktmorgen:optin     the form was sent; detail.status is "sent" when the
                      confirmation email is on its way, else "email",
                      "limited", "closed" or "error"
marktmorgen:close     the overlay closed; detail.reason says how
marktmorgen:purchase  back from paying (on document); detail is
                      { product, order }`}</Code>
        <Code>{`document.addEventListener("marktmorgen:purchase", (event) => {
  // event.detail.order is the id of the sale.completed webhook for this order
  showThankYou(event.detail.product);
});`}</Code>
        <p>
          {`The purchase event: after paying, the receipt page shows a button back to the return page, whose address ends in #mm-purchase=<product>.<order>. The script on that page reads that mark from the address once, says marktmorgen:purchase, keeps it in window.Marktmorgen.purchase and takes the mark off the address. order is the same id as the sale.completed webhook's, so your server and your page can be matched.`}
        </p>
        <p>
          These events are for what your page shows. Anybody can make a page say them, so never hand anything over because of one: what was
          paid is told to your server by the signed {c("sale.completed")} webhook, and a confirmed sign-up by {c("list.joined")}. The sign-up
          is a double opt-in: {c("sent")} means the email with the button is on its way, and the address joins your list only once it is
          pressed.
        </p>
        <p>
          Underneath, the frame sends {c("window.postMessage")} messages of the form {c('{ marktmorgen: 1, type, height?, status? }')} to your
          site&apos;s origin alone, and the script takes a message only from {c("https://marktmorgen.com")} and only from the frame it opened.
          The frame listens to no message from your page.
        </p>
      </LegalSection>

      <LegalSection title="Webhooks">
        <p>
          {`sale.completed now carries source: utm_source, utm_medium, utm_campaign and utm_content as the sale was tagged, and site, the listed site the checkout script opened it for, each null when there is none. list.joined is sent when somebody confirms their address to join your list, from your store page's box, one of your forms or the script, with their email, whether they allowed their link use in sequences to be seen, the form, the site and when they asked. Webhooks are signed and retried as on every other event; a store has up to ${MAX_ENDPOINTS} addresses.`}
        </p>
      </LegalSection>

      <LegalSection title="What the script does, and does not">
        <p>
          It listens for clicks on links that carry {c("data-mm")} and point at {c("https://marktmorgen.com/embed/")}, and reads that link&apos;s
          address, its {c("data-mm")} and its text, which names the dialog. It reads nothing else on your page: no field, no cookie, no storage,
          no other element. It sets no cookie. It holds no key and no secret: the link names only your store and a product, and the price is
          always read from your store when the checkout opens. It makes no request when the page loads; Marktmorgen is asked for something only
          when somebody presses a link.
        </p>
        <p>
          It draws the overlay as the browser&apos;s own modal dialog, with a close button. While it is open, the keyboard stays in the card and
          its close button, and the rest of your page cannot be reached. Once the card has loaded, the focus goes into it, unless the person
          has already moved it, for example to the close button. That button shows a ring of its own when it has the focus. Escape, the close
          button or a click beside the card closes it and gives the focus back
          to the link. A page that still has version 1 keeps working as before, without holding the keyboard in the dialog. It adds one global, {c("window.Marktmorgen")}, with {c("version")}, {c("purchase")} and {c("close()")}, and does nothing if it
          is on the page twice.
        </p>
        <p>{`This is version ${SCRIPT_VERSION}, in full. It is the same for every store, so its hash is the same too:`}</p>
        <Code>{loaderSource()}</Code>
      </LegalSection>

      <LegalSection title="Content-Security-Policy">
        <p>If your site sends a Content-Security-Policy, these let the script run and its frame open:</p>
        <Code>{cspLines(hash).join("\n")}</Code>
        <p>
          The hash matches the script exactly as the studio gives it. A builder that changes pasted code as it saves it changes the hash too;
          there, use the link on its own, which needs no policy at all.
        </p>
        <ul className="list-disc space-y-2 pl-5">
          {BUILDERS.map((builder) => (
            <li key={builder.name}>
              <strong>{builder.name}.</strong> {`${builder.where} ${builder.policy}`}
            </li>
          ))}
        </ul>
        <p>
          On Marktmorgen&apos;s side, only the card and form pages under {c("/embed/")} may be framed by other sites; every other page of
          Marktmorgen may be framed only by Marktmorgen itself.
        </p>
      </LegalSection>

      <LegalSection title="Limits">
        <ul className="list-disc space-y-2 pl-5">
          <li>{`Up to ${MAX_EMBED_SITES} sites per store, https only.`}</li>
          <li>{`Up to ${OPENS_PER_TEN_MINUTES} cards or forms opened per connection per store in ten minutes; past that, the plain link shows until the ten minutes are over.`}</li>
          <li>
            Each person who opens a card or a form counts as a visit to your store, once a day, toward the visits your plan covers. A store past
            them shows the plain link, as its other pages rest.
          </li>
          <li>The checkout and the sign-up form keep their own limits: 20 checkouts per connection per store in ten minutes, and 10 sign-ups per connection per store and 5 per address in an hour.</li>
          <li>A view of a page that holds the script costs nothing and counts nothing: the script is written into your page and asks for nothing until it is pressed.</li>
        </ul>
      </LegalSection>

      <LegalSection title="What it does not do">
        <ul className="list-disc space-y-2 pl-5">
          <li>It does not draw Stripe&apos;s card form inside your page. Stripe&apos;s checkout opens on Stripe&apos;s own page.</li>
          <li>It does not pick one of a product&apos;s price options for the buyer: a product with options, a plan, a box at checkout or a time to book opens its own page, where the buyer chooses.</li>
          <li>It does not read your page&apos;s address for tags or affiliate codes: what a link carries is what you put in it.</li>
          <li>The overlay inside a builder that frames pasted code opens inside that frame. Use the link that opens a page there.</li>
        </ul>
      </LegalSection>
    </LegalPage>
  );
}
