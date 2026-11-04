import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { BUYER_CAP_MONTHS, BUYER_NOTICE_DAYS } from "@/lib/closing-buyers-rules";
import { CLOSING_CHECKOUT_SECONDS } from "@/lib/closing-plan-guard";
import { CENTS_PER_MINUTE, GIVE_UP_HOURS, MIN_CENTS, dollars } from "@/lib/auto-captions-rules";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { DISPUTE_KEPT_WORDS, DISPUTE_OUTCOME_WORDS, DISPUTE_PAUSED_WORDS } from "@/lib/plan-dispute-rules";
import { RENEWAL_KEPT_WORDS, RENEWAL_PAUSED_WORDS, RENEWAL_RESUME_WORDS } from "@/lib/renewal-unpaid-words";
import { isDomainsConfigured } from "@/lib/domains";
import { formatMoney } from "@/lib/money";
import { PRO_MONTHLY_EMAILS, REFUND_DAYS, SCALE_MONTHLY_EMAILS, TRIAL_MONTHLY_EMAILS, PLAN_TITLES } from "@/lib/plan";
import { healthRuleWords } from "@/lib/mail-health-rules";
import { DELIVERY_ALLOWANCE_BYTES, FREE_PAUSE_ABOVE_BYTES, bytesWords } from "@/lib/delivery";
import { hoursWords } from "@/lib/watch-rules";
import { paidVideoWords, TRIAL_VIDEO_SECONDS } from "@/lib/video-admission-rules";
import { SETUP_STORAGE_BYTES, SETUP_VIDEO_SECONDS, TRIAL_STORAGE_BYTES } from "@/lib/plan-standing";
import { CLOSING_DAYS, ENDED_STORE_EXPORTS, ERASE_WITHIN_DAYS, KEEP_NOTHING_FROM, WARN_MONTH_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { RELEASE_QUARANTINE_DAYS } from "@/lib/store";
import { CALL_ORDER_UNITS, ORDERS_INCLUDED, TRIAL_ORDERS } from "@/lib/order-rules";
import { API_WRITE_UNITS, allowanceListWords } from "@/lib/store-allowance-rules";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { FREE_POOL_BASE_STORES, PAID_STORES_PER_FREE_STORE } from "@/lib/free-pool-rules";
import { BUYER_RESERVE_BPS, EXTRA_REQUESTS, REQUESTS_PER_VISIT, ROOM_IDLE_PARTS, ROOM_LIVE_PARTS, SETUP_VISITS, TRIAL_VISITS, VISITS_INCLUDED, countWords, partsWords } from "@/lib/traffic-rules";
import { ROOM_GRANT_MINUTES } from "@/lib/chat-pace";
import { STORAGE_BRAKE_BYTES, storageWords } from "@/lib/storage-quota";
import { NON_PAYING_DATA_ROOM_BYTES, dataRoomListWords, dataWords } from "@/lib/store-data-rules";
import { INVITE_PROGRAM_OPEN, INVITE_PAUSE_NOTICE, INVITE_BONUS_CENTS, INVITE_HOLD_DAYS, INVITE_SHARE_PERCENT } from "@/lib/creator-invite-rules";
import { feeWords, planPriceWords } from "@/lib/fee-words";
import { TASK_ROOM_BYTES } from "@/lib/assignment-rules";
import { COMMUNITY_PICTURES } from "@/lib/community-picture-rules";
import { ASSISTANT_KEEP_SECONDS, ASSISTANT_MESSAGES_MONTHLY, ASSISTANT_NAME, ASSISTANT_PRICE_CENTS } from "@/lib/store-assistant-rules";

export const metadata: Metadata = {
  title: "Terms of Service — Marktmorgen",
  description:
    "Terms of Service for Marktmorgen: the creator store at marktmorgen.com, what a creator is responsible for when they sell through it, and how payment works.",
};

export default function TermsPage() {
  const domains = isDomainsConfigured();
  return (
    <LegalPage title="Terms of Service" lastUpdated="November 2, 2026">
      <p>
        These Terms of Service (“Terms”) govern your access to and use of the
        websites, products, and subscription services operated by Solrenning
        under the name Marktmorgen (“Marktmorgen,” “we,” “us,” or “our”). They
        cover this website and the Marktmorgen creator store (collectively,
        the “Services”).
      </p>
      <p>
        Solrenning is an independent software studio. We sell software to
        customers worldwide. By creating an account, purchasing a subscription,
        or otherwise using the Services, you agree to these Terms. If you do
        not agree, do not use the Services.
      </p>

      <LegalSection title="1. Eligibility and accounts">
        <p>
          You must be at least 18 years old, or the age of majority in your
          jurisdiction if that is higher, to use the Services. By using the Services, you confirm
          that you meet this requirement.
        </p>
        <p>
          You are responsible for providing accurate account information and for
          keeping your email inbox and any passkeys you add secure, since they
          are how you sign in. You are also responsible
          for all activity that occurs under your account. Notify us promptly at{" "}
          <a
            href="mailto:support@marktmorgen.com"
            className="text-black underline underline-offset-2 hover:no-underline"
          >
            support@marktmorgen.com
          </a>{" "}
          if you believe your account has been compromised.
        </p>
        <p>
          <strong className="text-black">Several stores and a team.</strong>{" "}
          One account may run up to five stores. Each store is a subscription
          of its own; the free trial applies to an account&apos;s first store
          only. The owner of a store may invite up to five people to its team.
          Team members sign in with their own email address and act on the
          owner&apos;s behalf, within the role the owner gives them: what they
          do in the studio is done for the owner, and the owner remains
          responsible for the store and for what the team does in it under
          these Terms. Only the owner pays for the store, connects its Stripe
          account, manages its team and deletes it. The owner may also copy
          one of their stores into another of their own stores: its products,
          pages, forms and funnels arrive there as drafts, and its store
          page&apos;s setup when the owner asks for it; never its customers,
          orders, contacts, emails, answers, reviews, payments, payout
          details, files or pictures. Each step of a copy is some of the
          receiving store&apos;s studio requests for its billing month, and
          what it writes takes room in that store&apos;s data; a copy that
          does not fit as a whole is refused before anything is written.
        </p>
        <p>
          We may suspend or terminate accounts that violate these Terms or that
          we reasonably believe pose a risk to the Services, other users, or
          our operations.
        </p>
      </LegalSection>

      <LegalSection title="2. The Services">
        <p>
          <strong className="text-black">The Marktmorgen creator store.</strong> A
          hosted store page where a creator sells digital files, courses,
          memberships and calls, and can run a community for their buyers and
          an affiliate program. The buyer pays into the creator&apos;s own connected Stripe
          account, and the file is delivered as soon as the payment clears.
          {feeWords().termsCharge}
        </p>
        <p>
          Creator stores are open. Taking a store address, building the page and
          connecting a Stripe account are free. Taking a card on that page
          requires a paid subscription, which, on an account&apos;s first
          store, begins with a free trial of 14 days, and which renews every month or every year, whichever you chose,
          at the price shown on the home page until it is canceled. The price
          and the payment provider are shown before any card is asked for, and
          these Terms apply to that subscription. We email you at least seven
          days before the first charge after the trial, and, on a yearly
          subscription, between 15 and 45 days before each renewal, with the
          date, the amount and how to cancel.
        </p>
        <p>
          We may update, improve, or discontinue features. When practical, we
          will provide reasonable notice of material changes. Except for a
          creator store used as described in section 3, the Services are
          provided for your personal or internal business use. You may not
          resell, sublicense, or offer the Services to third parties as your
          own product without our prior written permission.
        </p>
      </LegalSection>

      <LegalSection title="3. Selling through a Marktmorgen store">
        <p>
          This section applies if you use Marktmorgen to sell to your own buyers.
        </p>
        <p>
          <strong className="text-black">You are the seller.</strong> Each sale
          made through your store is a contract between you and your buyer.
          Marktmorgen is not a party to it, is not the merchant of record for
          it, and does not sell your products to anyone.
        </p>
        <p>
          <strong className="text-black">The money is never ours.</strong>{" "}
          Payments are made into your own Stripe account through Stripe direct
          charges. {feeWords().termsMoney}
          Payouts follow the schedule and settings of your own Stripe account,
          and your relationship with Stripe is governed by your agreement with
          Stripe, not by these Terms.
        </p>
        <p>
          <strong className="text-black">What you are responsible for.</strong>{" "}
          The product you sell and its description and price; having the rights
          to everything you upload and sell; answering your own buyers;
          refunds, disputes, and chargebacks on your own sales; and any tax you
          owe on your sales, including sales tax, VAT, or GST where it applies
          to you. If you run an affiliate program, paying your affiliates what
          you agreed is yours too: we keep the record, and we never hold or
          pay out that money. That includes pay per lead: what counts as a
          lead, its amount, hold, caps and budget are yours to set, approving
          or reversing each lead is your decision, and you must not use it to
          pay for sign-ups or bookings that people did not make themselves. If you run a community, what is posted in it is
          yours to moderate, and the rules in section 4 apply to it.
        </p>
        <p id="instant-access" className="scroll-mt-24">
          <strong className="text-black">Starting before the 14 days end.</strong>{" "}
          In the European Union, the United Kingdom and some other places, a
          consumer who buys online usually has 14 days to cancel. For digital
          content (a file, a link, a course, a private podcast or a bundle),
          they lose that right once access starts only if they agreed that it
          may start before the 14 days end, said they understood they would
          lose the right, and got a confirmation of both. A membership is at
          least partly a service: they ask for it to start now, keep the right
          to cancel within the 14 days, and if they do, pay only for what they
          were given until then. So before a buyer pays, the checkout asks them
          to check one box that says the one that fits, in your store&apos;s
          language, and does not open the payment without it. Each one-click
          offer after paying asks again. The buyer&apos;s &ldquo;yes&rdquo;,
          the version and kind of the sentence and the time are kept on the
          order in your Stripe account, and the confirmation email quotes
          them. A pre-order&apos;s buyer keeps the right until its release day,
          and a shipped item keeps its own. If a member cancels within the 14
          days, refunding what they paid beyond what they were given until
          then is yours to do, from your Stripe account. We ask the same way
          for every buyer, because a page cannot know who has the right; the
          words say it is for buyers who have it where they live. Your own
          terms, refund policy and descriptions are yours: do not promise
          less than this, for example &ldquo;no refunds&rdquo; to a buyer who
          did not check the box. We do not give legal advice, and this box
          does not make your sales meet every law where your buyers are.
        </p>
        <p>
          <strong className="text-black">Payment requests.</strong> Send a
          payment request only to a person who agreed to pay you for what it
          lists, for what you are owed or agreed. It is not for marketing, for
          asking someone you have no dealings with, or for a sum they dispute.
          You are the seller of what it is for, and its refunds and disputes
          are yours, as for any sale. Nothing is added to what the person pays
          for paying by request: no fee, no interest and no late charge, and a
          request may not be used to add one. Each request and each reminder
          is one of your store&apos;s emails for the month. We may switch
          payment requests off for a store that misuses them.
        </p>
        <p>
          <strong className="text-black">Proposals and agreements.</strong>{" "}
          You may send a proposal or an agreement for electronic signature
          only to a person you deal with, who expects it. You write its terms
          and you are responsible for them; Marktmorgen is not a party to it,
          provides no legal advice or templates, and does not check what it
          says. What we record when it is signed is the exact text shown, its
          SHA-256 fingerprint, the version, the name typed, the time, the
          consent sentence checked and a one-way code made from the
          signer&apos;s internet address. We do not promise that a signature
          made here is valid or enforceable for any purpose or in any place:
          that depends on the law where the parties are and on what the
          document is, and some documents need another form. Never sign, or
          ask anyone to sign, for someone else. Each email it sends is one of
          your store&apos;s emails for the month. We may switch agreements off
          for a store that misuses them.
        </p>
        <p>
          <strong className="text-black">Reviews.</strong> Reviews on your
          store come only from buyers whose payment your Stripe account
          confirms. You may answer a review, and hide one only for one of
          the review rules: it shares private information, is abusive or
          hateful, is not about the product, is clearly false, or breaks the
          law. The rules are the same for every rating; you may not hide a
          review because of its stars or because it criticizes you. You may
          not offer anything in return for a review, or present as a review
          anything a buyer did not write. A hidden review still counts
          in your average, and your page says how many are hidden.
        </p>
        <p>
          <strong className="text-black">Services you choose to connect.</strong>{" "}
          If you connect an email platform (Mailchimp, Kit, beehiiv or
          MailerLite), your Google Calendar or, once it is offered, your Zoom
          account, or choose Jitsi Meet rooms or your own meeting link for
          your calls and live events, that is your choice. Those services are run by third parties under their own
          terms and privacy policies, your account with them is yours, and we
          are not responsible for what they do or for their availability.
          Send to an email platform only people who agreed to hear from you;
          the Services send only those who did. A meeting made on your Google
          or Zoom account is yours: it stays there if you disconnect, and
          what that service does with it is between you and them.
        </p>
        <p>
          <strong className="text-black">
            Ad pixels, and purchases sent to ad platforms.
          </strong>{" "}
          When you add a Meta, Google, TikTok, Pinterest, X or Reddit pixel to your store,
          or give us an access token so that purchases, membership payments and
          sign-ups are also sent to that platform from our server, you are instructing us to send that data to
          that platform on your behalf, and you are responsible for doing so
          lawfully. That means telling your visitors and buyers about it in your
          own privacy notice, giving any notice or opt-out link the law where
          you or they are requires, and following that platform&apos;s own
          terms for its business tools, which you accept with that platform.
          The Services do their part: where the law asks for consent first
          (the European Economic Area, the United Kingdom, Switzerland and
          Brazil, and any country we cannot tell) nothing is sent unless the
          visitor agrees; a browser that sends Global Privacy Control is never
          sent; a link at the foot of your pages changes the choice; and an
          email address is sent only hashed. Do not use these tools for a
          store aimed at children, or to send anything that reveals a
          person&apos;s health, beliefs or other sensitive matters. We may
          switch them off for a store that misuses them.
        </p>
        <p>
          <strong className="text-black">
            Your buyers&apos; addresses for ad audiences.
          </strong>{" "}
          The file of buyers for ad audiences holds the addresses of buyers who
          agreed to hear from you and have not left your list. Uploading it to
          an ad platform is your decision and yours to answer for: do it only
          where your buyers&apos; permission and your own privacy notice cover
          that use, which in some places means having asked for it in so many
          words, and follow that platform&apos;s terms for customer lists. We
          do not send the file anywhere ourselves.
        </p>
        <p>
          <strong className="text-black">Slack and Discord.</strong> When you
          give us a Slack or Discord webhook address, you ask us to post your
          store&apos;s weekly and monthly numbers there. Anyone who can read
          that channel reads them, so choose it as you would choose who gets
          the email; what that service does with them is between you and it.
        </p>
        <p>
          <strong className="text-black">Questions your store asks.</strong>{" "}
          If you leave on the question after paying (&ldquo;where did you hear
          about us?&rdquo;), or turn on the question on your sales pages
          (&ldquo;is anything stopping you from buying?&rdquo;), the answers are
          counted for your numbers and kept with nothing that identifies the
          person who gave them. Use them to improve your store, not to contact
          or single out anyone.
        </p>
        <p>
          <strong className="text-black">
            Bringing a store from another platform.
          </strong>{" "}
          When you import contacts, you confirm, and are responsible for it
          being true, that every person in the file agreed to receive your
          emails, and that you may lawfully give us their details. When you
          import past buyers, you confirm that each person bought what the
          file says from you, that you have the right to give it to them
          here, and, if you ask us to email them, that you may tell them so.
          We check the file&apos;s format, not the truth of it, and we may
          switch off imports or email for a store that misuses them.
        </p>
        <p>
          <strong className="text-black">What you may not sell.</strong>{" "}
          Anything unlawful; anything that infringes someone else&apos;s rights;
          sexual content; anything that misleads your buyer about what they are
          paying for; anything that promises fast or easy money, or income for
          little effort; and anything that falls under the list of restricted
          businesses published by Stripe, since your payments run through
          Stripe.
        </p>
        <p>
          <strong className="text-black">Content sold with resale rights.</strong>{" "}
          You may sell content you did not make yourself, such as material
          sold with private label or resale rights, only under a license that
          lets you sell it the way you sell it here, and only when your product
          gives the buyer something to use beyond the right to sell it on. You
          keep that license and show it to us on request, and we may remove a
          product whose license you cannot show.
        </p>
        <p>
          We may remove a product or suspend a store that breaks this section.
          Doing so does not affect the money already in your own Stripe
          account.
        </p>
        <p>
          The same goes for the links on your page and anything played on it:
          link to, and play, only videos, music and podcasts that are yours or
          that their owner published on that service. When someone tells us
          that content on your store infringes their copyright or is illegal,
          we follow our{" "}
          <Link href="/copyright" className="text-black underline underline-offset-2 hover:no-underline">
            Copyright and Takedown Policy
          </Link>
          : we may take the content down, we tell you and how to answer, and we
          switch off the pages and sales of a store that is the subject of
          repeated valid notices. Your buyers keep what they already bought
          for as long as the store is open (section 8).
        </p>
      </LegalSection>

      <LegalSection title="4. Acceptable use">
        <p>You agree not to:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>
            use the Services for unlawful, harmful, fraudulent, or abusive
            purposes;
          </li>
          <li>
            attempt to reverse engineer, disrupt, overload, or interfere with
            the Services;
          </li>
          <li>
            submit content that infringes another person’s rights or that
            contains malware;
          </li>
          <li>
            circumvent usage limits, payment requirements, or security
            measures; or
          </li>
          <li>
            upload or sell anything you do not have the right to distribute.
          </li>
        </ul>
        <p>
          If you email your list through the Services, you also agree to write
          only to people who agreed to hear from you; never to import an
          address that was bought, rented, borrowed or collected without that
          agreement; to give a true postal address where you can be reached,
          which we print at the bottom of each email; to write subject lines that
          are not misleading; and to follow the laws on commercial email that
          apply to you and to your readers, including the CAN-SPAM Act in the
          United States. Every email carries an unsubscribe link that we honor
          permanently, and you may not ask anyone to do more than click it. An
          address that cannot be delivered to, or whose owner reports an email
          as spam, is taken off your list automatically and is not written to
          again. {healthRuleWords()}
        </p>
        <p>
          If you use Outreach to write to a business, you are the sender of
          that email: it leaves from your own mailbox, under your own name. You
          agree to send it only to the business address the studio found for
          it, with the closing lines the studio adds left as they are; to send
          what you have read and stand behind, with nothing in it that is
          untrue; never to use it to write to a private person, or to a list;
          to stop writing to a business the moment it asks, and to record it
          in your studio; and to follow your mail provider&apos;s rules and the
          laws on commercial email that apply to you and to the business you
          write to. The studio refuses what it can tell is not allowed, but it
          is not legal advice, and what you send is yours to answer for.
        </p>
        <p>
          We may investigate suspected violations and take action, including
          pausing a send, switching off email for a store, or suspending or
          terminating your account.
        </p>
      </LegalSection>

      <LegalSection id="fair-use" title="5. What the subscription covers">
        <p>
          The published limits are the ones in your studio and on our pricing
          page: the number of products a store may list, the size of a single
          file, how many emails a month a plan may send,{" "}
          {bytesWords(DELIVERY_ALLOWANCE_BYTES)} of downloads a month per
          store, lesson video watched for {paidVideoWords()} a
          month per store, the visits and orders a month your plan covers,
          and the monthly figures of imports, workflows and shared funnels.
          You can see every one of them while you use the Services. Use past
          a plan&apos;s figures is not sold or billed: what needs the figure
          waits for your next billing month or a larger plan, as each part of
          this section says.
          None of them is hidden in this document and then discovered by being
          enforced against you.
        </p>
        <p>
          <strong className="text-black">Your billing month.</strong> A paid
          plan&apos;s monthly figures are counted in your billing month, not
          the calendar month: it begins on the day your plan renews and ends
          when the next payment&apos;s month begins, so each payment buys one
          month of every figure. A yearly plan&apos;s figures are monthly too,
          each month beginning on the day of the month your year began. A free
          trial&apos;s figures are counted for the trial as a whole, and a
          store with no plan, before one starts or after one ends, counts them
          by calendar month (UTC). Until we have read your plan&apos;s billing
          month from our payment processor (when you next open your studio, or
          within a day), uses that cost us money wait, and a buyer who is
          already paying is never stopped.
        </p>
        <p>
          <strong className="text-black">The other monthly figures.</strong>{" "}
          Each billing month also covers: on {PLAN_TITLES.creator},{" "}
          {allowanceListWords("creator")}; on {PLAN_TITLES.pro},{" "}
          {allowanceListWords("pro")}; and on {PLAN_TITLES.scale},{" "}
          {allowanceListWords("scale")}. A studio request is any page of your
          studio you open (each counts as {STUDIO_PAGE_UNITS}), any save, and
          the studio&apos;s own refreshing; an API request is one made with
          one of your store&apos;s keys (a contact added or a product given
          counts as {API_WRITE_UNITS}); store emails are the emails your
          store&apos;s own tools send outside your monthly emails and your
          orders (inbox notices and replies, a purchase sent again, reminders,
          offers, notices to members); access emails hand a buyer what they
          already have (a link to their purchases, a course, a private
          podcast, a place in a purchase made for several people); buyer
          actions are what your buyers, and you, do inside what was bought
          other than opening its pages (a community post, comment, like,
          message, RSVP or picture, a lesson comment, a hand-in, a lesson
          marked done, a certificate; what you do there yourself counts as
          studio requests, and deleting what one wrote is not counted); a
          webhook delivery is each try to send one of your webhooks,
          retries and tests included, and each one not sent because your
          plan&apos;s renewal payment did not go through or a payment for it
          is disputed. When one is used, that use is refused with a plain
          message until your next billing month or a larger plan; nothing is
          billed past it. Changing your plan, canceling it, deleting your
          store and downloading your sales are never refused for it. Your
          store&apos;s public side also answers up to{" "}
          {countWords(REQUESTS_PER_VISIT)} requests for each visit its plan
          covers and a number more ({countWords(EXTRA_REQUESTS.creator)} on{" "}
          {PLAN_TITLES.creator}, {countWords(EXTRA_REQUESTS.pro)} on{" "}
          {PLAN_TITLES.pro} and {countWords(EXTRA_REQUESTS.scale)} on{" "}
          {PLAN_TITLES.scale}): pages, searches, the cart, downloads and the
          page after paying. Past them its pages rest as they do for visits.
        </p>
        <p>
          <strong className="text-black">Stores that pay nothing.</strong>{" "}
          Free trials, stores with no plan and stores whose plan has ended
          share a limited number of places each calendar month:{" "}
          {countWords(FREE_POOL_BASE_STORES)}, and one more for every{" "}
          {countWords(PAID_STORES_PER_FREE_STORE)} paying stores. A store that
          pays nothing uses its place the first time in a month it does
          something that costs us money. When the places are taken, such a
          store is told plainly, and what it asked for waits until the next
          month or until its plan is paid.
        </p>
        <p>
          We do not stop a download because a store has passed that figure.
          Somebody paid you for that file, and cutting your buyer off to
          protect our costs would be taking money for a sale and then not
          completing it. A paid download is never refused, at any number.
        </p>
        <p>
          Nothing is charged for downloads, inside that figure or past it.
        </p>
        <p>
          Visits, orders and lesson video have finite monthly admission
          thresholds. Public pages pause at the recorded counted-visit
          threshold, and a paid store&apos;s new orders at its orders figure. New stream
          playback pauses at the recorded watched-time threshold; an unavailable
          or invalid admission measurement does not authorize new playback.
        </p>
        <p>
          <strong className="text-black">Lesson video.</strong> Paid plans cover
          {" "}{paidVideoWords()} each month. Free trials have {hoursWords(TRIAL_VIDEO_SECONDS)}{" "}
          a month. Before a plan starts and after one ends, the threshold is
          {" "}{hoursWords(SETUP_VIDEO_SECONDS)}. New playback pauses at the applicable threshold until the next
          billing month or a plan change provides capacity. Existing player
          links may remain valid until they expire. Watching is measured about
          once an hour; the meter is not a limit on transferred bytes. Video
          sold or served as a file follows the separate download path. Other
          course content remains available.
        </p>
        <p>
          Captions written by AI for a lesson&apos;s video are bought when you
          ask for them, not billed by use: {dollars(CENTS_PER_MINUTE)} for each
          minute of the video, the minutes rounded up, for each language
          asked, and never less than {dollars(MIN_CENTS)} for one request. The
          price is shown before you confirm and is charged at once to the card
          your plan is paid with, on an invoice of its own. If the captions in
          a language are not delivered within {GIVE_UP_HOURS} hours, what was
          paid for that language is refunded automatically. A refund counts as
          made only once Stripe confirms it. Until then we check it again on
          our own for about ten days, and the course&apos;s page in your studio
          shows the refund as not confirmed yet; if it is still not confirmed
          after that, the page says we have stopped checking on our own and
          gives the address to write to. They are written
          by a machine from what is said in the video and may contain
          mistakes; you are responsible for reviewing them before your
          students rely on them.
        </p>
        <p id="store-assistant">
          The {ASSISTANT_NAME} is an add-on, sold for one store at{" "}
          {formatMoney(ASSISTANT_PRICE_CENTS, "usd")} a month as a subscription
          of its own, charged to the card your plan is paid with. It is sold
          only to a store whose plan is paid, after its free trial. Each month
          of it holds {ASSISTANT_MESSAGES_MONTHLY.toLocaleString("en-US")} AI
          replies at the most each can cost; a reply that costs less gives the
          difference back, so a month holds at least that many. When they are
          used, the chat becomes a form that leaves buyers&apos; questions for
          you until its next month begins; nothing more is charged. It answers
          only from what your store publishes and from the notes you write
          for it, labels every reply as written by AI, and may still be wrong:
          you are responsible for what your store publishes, which is what it
          repeats. It never offers a price, a discount or a term you did not
          publish, and its replies are not an offer or a contract on your
          behalf. You can stop it at any time; it stays on until the end of
          the month already paid. If your plan ends, it is set to stop at the
          end of the month already paid. Its payments are not refunded, except
          where applicable consumer law requires it. A disputed payment ends
          it at once, and it is not sold to that store again. A conversation
          with it is kept for {ASSISTANT_KEEP_SECONDS / 3_600} hours after its
          last message, without the buyer&apos;s name or address, and is sent
          to Anthropic&apos;s AI model to write the replies; see the Privacy
          Policy.
        </p>
        <p id="store-assistant-next">
          The {ASSISTANT_NAME} can also, when you switch it on, show a buyer
          one more of your own products after a purchase, on the page after
          paying and, if you allow it, in that order&apos;s confirmation email
          to buyers who agreed at checkout to hear from you. It shows only
          products you list and sell, at the price and terms on their own
          pages, never one the buyer already bought from you or turned down
          after paying, and follows your own choices first (what goes well with
          a product, its offers after paying, its checkout boxes, its
          collections). Only when you made none does an AI choose among your
          products, labeled as an AI suggestion; each such choice is one reply
          of the add-on&apos;s month, and once those are used your store&apos;s
          own order decides. It is a suggestion, not an offer of different
          terms: a purchase that follows it is an ordinary sale of yours.
        </p>
        <p id="store-assistant-reminder">
          The {ASSISTANT_NAME} can also, when you switch it on and have given
          the postal address your checkout reminders carry, show an unchecked
          box at your checkout for one reminder by email if the buyer does not
          finish. It is sent only to a buyer who checked that box and typed an
          address, at most once for each checkout, about an hour after it
          closed unpaid, in your name, with your postal address and a link that
          stops your reminders at once; never when the checkout was paid, when
          that address paid for the same products since, or stopped or left
          your emails. Its AI line, labeled as written by AI, comes from your
          own product descriptions and is one reply of the add-on&apos;s month;
          when those are used the same email goes without it. Each reminder is
          one of your store&apos;s own emails for the month and is not sent once
          those are used. You are the sender of these emails and responsible
          for what your products&apos; pages say, which they repeat, and for
          the postal address you give being one where you receive mail. Without
          that address the box is not shown and nothing is sent.
        </p>
        <p>
          A visit is one person opening your store on one day, however many
          of its pages they look at. People are told apart by the network
          address they come from, and by nothing kept in their browser. You
          are never counted when you are signed in, and neither is a robot
          that says it is one. Your plan covers a number of visits in each
          billing month: {countWords(VISITS_INCLUDED.creator)} on{" "}
          {PLAN_TITLES.creator}, {countWords(VISITS_INCLUDED.pro)} on{" "}
          {PLAN_TITLES.pro}, and {countWords(VISITS_INCLUDED.scale)} on{" "}
          {PLAN_TITLES.scale}. Visits are not billed, and none are sold past
          that figure. Your store&apos;s public pages (its page, products,
          blog and collections, and the cards of the checkout script) rest
          once a month has had {(10_000 - BUYER_RESERVE_BPS) / 100}% of the
          figure; the last {BUYER_RESERVE_BPS / 100}% are kept for what your
          buyers already have (courses and lessons, the community and its
          live room, and private podcasts), which rest once the whole figure
          is used, with a page that tells your buyers their access is kept.
          Everything opens again with your next billing month, or when a plan
          change provides a larger figure. A checkout already open is never
          stopped by this. An unreadable count also pauses new public-page
          admission.
        </p>
        <p>
          A buyer who comes back is a visit like anybody else: a student or
          a member who opens a course or your community on a day is that
          day&apos;s visit, once. Two things a buyer&apos;s device does by
          itself are counted for what they cost. A subscriber to a private
          podcast is one visit on each day their podcast app checks for
          episodes, however often it checks. And your community&apos;s live
          room, which checks for new messages for as long as it is open in
          front of a member, counts for each member by the{" "}
          {ROOM_GRANT_MINUTES} minutes it is open: {partsWords(ROOM_LIVE_PARTS)}{" "}
          visits while people are talking, when it checks every few seconds,
          and {partsWords(ROOM_IDLE_PARTS)} of a visit while the room is
          quiet. A room in a background tab, or one nobody has touched for a
          while, checks nothing and counts nothing, and you are never
          counted in your own room.
        </p>
        <p>
          A store with no paid plan rests the same way until the plan is paid:{" "}
          {countWords(TRIAL_VISITS)} visits for the whole free trial, and{" "}
          {countWords(SETUP_VISITS)} a calendar month before a plan is started
          and after one has ended, until the month turns. A visitor to a resting store is
          told the page will be open again soon. Nothing is charged for
          visits, and downloads of what a buyer bought are not visits and are
          never part of the rest. The live room of a resting store
          stops checking by itself and shows new
          messages when a member asks for them.
        </p>
        <p>
          Orders are counted the same way. An order is one purchase confirmed
          (a bundle or a cart of several products is one), one offer taken
          after paying, one PayPal order, one place in a purchase made for
          several people, or one free copy sent to an address, each counted
          once; a package of calls is one order, and a call booked counts as{" "}
          {countWords(CALL_ORDER_UNITS)}, for the emails and reminders it
          sends. Your plan covers a number of orders in each billing month:{" "}
          {countWords(ORDERS_INCLUDED.creator)} on {PLAN_TITLES.creator},{" "}
          {countWords(ORDERS_INCLUDED.pro)} on {PLAN_TITLES.pro}, and{" "}
          {countWords(ORDERS_INCLUDED.scale)} on {PLAN_TITLES.scale}. Orders
          are not billed, and none are sold past that figure: when a paid
          store reaches it, new orders pause until the next billing month or
          a plan change that provides a larger figure. A buyer who tries to
          buy then is told plainly that the store is not taking new orders
          right now, and nothing is charged. A checkout opened in the
          preceding day counts toward the figure until it is paid or closes,
          so a buyer who is already paying is never stopped and receives
          everything bought. You are emailed automatically the first time a
          month reaches the figure.
          {feeWords().ordersShared} In the free trial, new orders, paid and
          free copies together, pause once the store has had{" "}
          {countWords(TRIAL_ORDERS)} in the trial, until the plan is paid; a
          buyer who is already paying is never stopped.
        </p>
        <p>
          What we ask in return is that the Services are used to sell your own
          work to your own audience, and not as general file hosting, a
          content delivery network, a backup service, or a way to distribute
          very large files at a scale the subscription does not cover.
        </p>
        <p>
          If your store passes the download allowance in a month, our system
          emails you the next morning with your own figure in it. That notice
          is automatic: it does not wait for anybody here to notice, and it
          reaches you whether or not we are looking. Your studio shows the
          same number at any time.
        </p>
        <p>
          Two things happen on their own, and neither touches a buyer. Free
          copies — files given away rather than bought — pause for the rest
          of the month once a store has sent out{" "}
          {bytesWords(FREE_PAUSE_ABOVE_BYTES)} in that month, and resume when
          the month turns; anything anyone has bought is unaffected. And new
          uploads stop once a store holds as much as it may:{" "}
          {storageWords(PAID_STORAGE_BYTES.creator)} on Store,{" "}
          {storageWords(PAID_STORAGE_BYTES.pro)} on Studio, and{" "}
          {storageWords(PAID_STORAGE_BYTES.scale)} on Scale. A free trial has
          the smaller of {storageWords(TRIAL_STORAGE_BYTES)} and its chosen
          plan&apos;s storage limit. The threshold is{" "}
          {storageWords(SETUP_STORAGE_BYTES)} for a store with no plan, before
          one is started or after one has ended. That asks you to remove
          something before adding more and changes nothing about what is
          already there or already sold. A store that holds more than its
          figure when its plan ends cannot add to it, and section 8 says how
          long it keeps what it holds. Files your students hand in have room
          of their own: {storageWords(TASK_ROOM_BYTES.creator)} on Store,{" "}
          {storageWords(TASK_ROOM_BYTES.pro)} on Studio and{" "}
          {storageWords(TASK_ROOM_BYTES.scale)} on Scale. Your community keeps
          up to {COMMUNITY_PICTURES.creator.toLocaleString("en-US")} pictures in its posts on Store,{" "}
          {COMMUNITY_PICTURES.pro.toLocaleString("en-US")} on Studio and{" "}
          {COMMUNITY_PICTURES.scale.toLocaleString("en-US")} on Scale; deleting a post
          with a picture makes room for another. Your store&apos;s words and
          records (products, pages, posts, courses, contacts, forms and their
          answers, and what each order keeps, counted at what it really
          writes) have a data room of{" "}
          {dataRoomListWords({ creator: "Store", pro: "Studio", scale: "Scale" })}{" "}
          ({dataWords(NON_PAYING_DATA_ROOM_BYTES.trial)} in a free trial). When it is full, what
          you or your buyers would add is refused with a plain message until
          something is deleted or the plan is larger; deleting is never
          refused, and an order already paid for is never refused: room for
          every checkout still open is held before it opens, so new checkouts
          pause when the room is close to full, as they do at the month&apos;s
          orders.
        </p>
        <p>
          Beyond those, we may limit or suspend a store only if use far above
          the published allowances continues after that notice has been sent
          and you have had a reasonable time to answer, or where the use is
          plainly abusive or unlawful. We will not do it silently, and never
          in the middle of delivering something a buyer has already paid for.
        </p>
      </LegalSection>

      <LegalSection title="6. Subscriptions and payment">
        <p>
          A creator store subscription is charged at the price shown at
          checkout, and these Terms apply to it. The sales a
          creator makes are not ours: they run through that creator&apos;s own
          Stripe account, as described in section 3.
        </p>
        <p>
          Payment is processed by Stripe, our payment provider. We do not
          store full payment card numbers. Prices are in United States dollars
          unless otherwise stated. You are responsible for any applicable
          taxes.
        </p>
        <p>
          We may change subscription prices. If we do, we will provide notice
          before the new price applies to a future billing period. The new
          price will not apply to a period you have already paid for.
        </p>
        <p>
          There are three plans. Store, at {planPriceWords("creator")} or {planPriceWords("creator", "year")},
          includes everything you need to sell. Studio, at {planPriceWords("pro")} or{" "}
          {planPriceWords("pro", "year")}, adds email to your list{domains ? " and your store on a domain you own" : ""},
          with up to {PRO_MONTHLY_EMAILS.toLocaleString("en-US")} emails a month,
          counted together for one-off emails, sequences, community
          announcements and the emails that ask buyers for a review; during
          the free
          trial a store may send up to {TRIAL_MONTHLY_EMAILS.toLocaleString("en-US")} emails a month, and the full
          number opens with the first payment. Emails not sent in a month do
          not carry over, and emails beyond a month&apos;s allowance wait for
          the next month. Scale, at {planPriceWords("scale")} or {planPriceWords("scale", "year")},
          is Studio with up to{" "}
          {SCALE_MONTHLY_EMAILS.toLocaleString("en-US")} emails a month, counted
          the same way. Reserved sending attempts count toward the allowance.
          If a provider cannot confirm delivery after dispatch, the reservation
          is retained and a retry uses new capacity. A failed or ambiguous
          capacity acknowledgement does not authorize a send.
        </p>
        {domains ? (
          <p>
            A domain you add stays yours: you keep it where you bought it and
            keep its settings. While your store is on Pro it opens your store;
            when Pro ends, its visitors are sent to your marktmorgen.com
            address, and you can take the domain off at any time.
          </p>
        ) : null}
        <p>
          You may switch between monthly and yearly billing, and between the
          plans, from your studio.
          A switch that costs more is charged when you make it, less the unused
          part of the period you already paid for. A switch that costs less
          leaves the unused part as credit on your account, applied to your
          next charges until it is used up. Credit is not paid out in cash,
          except where a refund applies under our Refund Policy.
        </p>
        <p id="renewal-unpaid" className="scroll-mt-24">
          <strong className="text-black">If a renewal payment does not go through.</strong>{" "}
          We learn it from Stripe at our daily check, or sooner when you open
          your studio or when we email you about it. {RENEWAL_PAUSED_WORDS}{" "}
          {RENEWAL_KEPT_WORDS} Your studio shows a link to Stripe&apos;s page
          that pays the open invoice. {RENEWAL_RESUME_WORDS} We see it at our
          next daily check, or at once when you open your studio. If Stripe
          ends the plan after its last try, section 8 applies.
        </p>
        <p id="plan-disputed" className="scroll-mt-24">
          <strong className="text-black">If you dispute a payment for your plan.</strong>{" "}
          When you dispute with your bank a payment you made to us for your
          plan, we learn it from Stripe at our daily check. {DISPUTE_PAUSED_WORDS}{" "}
          {DISPUTE_KEPT_WORDS} Your studio says so at the top.{" "}
          {DISPUTE_OUTCOME_WORDS} We see the bank&apos;s decision at our daily
          check. A dispute of a payment for the Store assistant ends the
          assistant as soon as we see it, and it is not sold to that store
          again.
        </p>
      </LegalSection>

      <LegalSection title="7. Creator invites" id="invites">
        {!INVITE_PROGRAM_OPEN ? <p>{INVITE_PAUSE_NOTICE} Previously accepted browser invitations retain their original 60-day expiry. The terms below describe existing invitations, not a new offer.</p> : null}
        <p>
          Under the invitation offer, your studio provided a link to invite other creators. When someone
          accepts your invite and then makes the first store of a new
          account, that store counts as invited by you. It does not count if
          the account belongs to you, if it had paid us before it was invited,
          or if another invite was accepted for it first.
        </p>
        <p>
          For every payment an invited account makes to us for its stores,
          we add {INVITE_SHARE_PERCENT}% of the amount actually paid, less any
          refund or credit given back on it, as credit on your account,{" "}
          {INVITE_HOLD_DAYS} days after the payment. After its first payment,
          the invited account gets {formatMoney(INVITE_BONUS_CENTS, "usd")} of
          credit on its own account, at the same time. Credit is applied by
          our payment provider to your next charges until it is used up. It is
          not paid out in cash, cannot be transferred, and is not refunded if
          you cancel.
        </p>
        <p>
          We may withhold or reverse credit earned through abuse, such as
          invites to accounts you control, and we may change or end this
          program for payments made after we give notice; credit already added
          stays yours. This pause alone does not change the rates or earned
          credit of existing invitations.
        </p>
      </LegalSection>

      <LegalSection title="8. Cancellation and closing a store" id="closing">
        <p>
          You may cancel your subscription at any time, for any reason. After
          you cancel, you will not be charged for future billing periods. You
          will retain access until the end of the period you have already paid
          for, unless a refund applies under our Refund Policy.
        </p>
        <p>
          <strong className="text-black">A store closes {CLOSING_DAYS} days after its plan ends.</strong>{" "}
          Until then the store stays as it is: its page, products, prices,
          files, courses, community, contacts and orders, and buyers go on
          reaching what they bought. We email the store&rsquo;s owner when the
          plan ends, {WARN_MONTH_DAYS} days before the closing day and {WARN_WEEK_DAYS} days
          before it, each time with the date, and a store never closes sooner
          than a week after the last of those emails. Starting a plan again
          before that day stops it, and everything stays exactly as it was.
        </p>
        <p>
          On the closing day the files the store keeps are removed (the files
          its products hand over, its lessons&rsquo; videos and downloads, its
          podcast&rsquo;s episodes, the files its students handed in and the
          pictures in its community&rsquo;s posts), and every membership and
          payment plan sold through it ends that day on the creator&rsquo;s
          own Stripe account. Within {ERASE_WITHIN_DAYS} days, and usually the same day,
          everything else the store keeps with us is deleted: its page and
          settings, products and prices, pages, posts, courses and the
          certificates they gave, community, contacts, forms and their
          answers, numbers, and its buyers&rsquo; access to what they bought
          from it. Its address is held back from
          anyone else for {RELEASE_QUARANTINE_DAYS} days. Your account and sign-in stay until you
          delete them, and you may open a new store.
        </p>
        <p id="closing-members">
          <strong className="text-black">Members and buyers of a store that closes.</strong>{" "}
          From the day a store&rsquo;s plan ends, we pause the collection of
          its memberships and payment plans on the creator&rsquo;s own Stripe
          account and void their unpaid invoices, so those members are not
          charged again, and they keep their access until the closing day. We
          do this for as many members as the closing&rsquo;s limit covers (the
          same limit as the emails below); a membership Stripe does not let us
          pause is tried again every day. A member we could not pause may
          still be charged until the closing day: the creator is told how
          many, and asked to refund any such charge. Every membership ends on
          the closing day. If the creator starts a plan again
          before then, each payment goes on as it was, and nothing is charged
          for the days in between. On the closing day, the part of a
          member&rsquo;s last payment that paid for time after that day is
          refunded automatically from the creator&rsquo;s own Stripe account,
          if its balance covers it, unless the creator already refunded it.
          The creator can make these refunds sooner from the studio, after
          seeing each amount. Marktmorgen never pays these refunds and never
          takes any part of them. If the balance does not cover a refund, it
          is not made, and we email the member to say so, with the
          creator&rsquo;s contact. At least {BUYER_NOTICE_DAYS} days before the
          closing day, we email everyone who bought from the store once, from
          Marktmorgen, with the date and what they can download before then;
          if the store stays open after that email, we tell them so. These
          emails go to as many buyers as the closing&rsquo;s cap allows ({BUYER_CAP_MONTHS}{" "}
          months of the plan&rsquo;s orders); the creator is told how many,
          if any, we could not write to. Starting a plan again before the
          closing day keeps the store. It can be started until{" "}
          {CLOSING_CHECKOUT_SECONDS / 60 + 1} minutes before that day begins
          (the studio shows the exact time), and
          its checkout lasts {CLOSING_CHECKOUT_SECONDS / 60} minutes. If a plan
          is still paid once the closing day has begun, we end that plan at
          once, refund its payment in full and email the creator.
        </p>
        <p>
          <strong className="text-black">Download what you want to keep before that day.</strong>{" "}
          The studio offers your whole store as one file: while your plan
          runs, as often as your plan&rsquo;s studio use allows, and{" "}
          {ENDED_STORE_EXPORTS === 1 ? "once" : `${ENDED_STORE_EXPORTS} times`}{" "}
          after it ends, before the closing day, whatever the store&rsquo;s
          size. It holds your products and their pages, posts,
          courses with every lesson&rsquo;s text, forms and their answers,
          contacts and your orders as a spreadsheet. Files and videos
          download from their own pages. Your students can download their
          course certificates until the closing day, and not after.
        </p>
        <p>
          <strong className="text-black">What we keep after a store closes.</strong>{" "}
          No copy of the store&rsquo;s sales. The store sells on your own
          Stripe account, which holds every sale, refund and payout and is
          yours to keep: those are your records as the seller. Our own
          records of the store are our invoices for its plan and any fee we
          charged, which stay in our billing records for as long as the law
          requires, and a note of the dates the store ended and closed, kept
          for about a year.
        </p>
        <p>
          <strong className="text-black">If you bought from a creator&rsquo;s store.</strong>{" "}
          What you buy from a store is delivered through that store while it
          is open on Marktmorgen. When it closes, what was bought from it can
          no longer be downloaded or opened here. From the day the
          store&rsquo;s plan ends we pause the payments for what you
          subscribe to there (unless the store is past the limit described
          above, or Stripe does not let us pause yours), and on the closing
          day it ends. We email the
          store&rsquo;s buyers at least {BUYER_NOTICE_DAYS} days before it closes, up to
          the limit its plan sets: as many buyers as {BUYER_CAP_MONTHS} months of the
          plan&rsquo;s orders, or 100 for a store that never paid. If a store has
          more buyers than that, we cannot promise that you are among those we
          email; the creator is told how many we could not write to and asked
          to tell them. If you paid for time after
          that day, the unused part is refunded to you from the
          creator&rsquo;s Stripe account, if its balance covers it; if it does
          not, we email you with the creator&rsquo;s contact. The creator is
          told {CLOSING_DAYS} days ahead and asked to give buyers another way
          to what they bought. Download the files and course certificates you
          want to keep before then. The store leaves your
          library on Marktmorgen when it closes; nothing else in it changes.
          A refund is a matter between you and the creator (section 9).
        </p>
        <p>
          A plan that ended before{" "}
          {new Date(KEEP_NOTHING_FROM).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}{" "}
          keeps the rule it ended under: the store and its records stay; a
          store that keeps {storageWords(SETUP_STORAGE_BYTES)} or less of
          files and lesson videos is not affected, and one that keeps more has
          its files removed {CLOSING_DAYS} days after the plan ended, after the
          same three emails, which deleting enough to keep{" "}
          {storageWords(SETUP_STORAGE_BYTES)} or less before that day also
          stops.
        </p>
      </LegalSection>

      <LegalSection title="9. Refunds">
        <p>
          Refunds of what you pay <em>us</em> are governed by our{" "}
          <Link
            href="/refunds"
            className="text-black underline underline-offset-2 hover:no-underline"
          >
            Refund Policy
          </Link>
          . In summary: within {REFUND_DAYS} days of your first payment to us,
          that payment and every plan payment for the same store made since
          are refunded in full on request, once, for any reason or none; a yearly
          plan is refunded at any time for the months not yet started, the
          months used being charged at the monthly price and the card
          processing fee Stripe charged on that payment being kept; and you may cancel
          at any time, keeping access to the end of the period already paid for.
        </p>
        <p>
          A refund on something you bought from a creator&apos;s store is a
          matter between you and that creator, who received your money in their
          own Stripe account and sets their own refund terms.
        </p>
      </LegalSection>

      <LegalSection title="10. Intellectual property">
        <p>
          Marktmorgen and its licensors own all rights in the Services,
          including the software, branding, design, and documentation. These
          Terms do not grant you any right to use our name, logos, or
          trademarks except as needed to identify the Services.
        </p>
        <p>
          You retain ownership of what you submit to the Services (“User
          Content”) — the files, images, text and descriptions you upload to
          your store. You grant Marktmorgen a limited license to host, store
          and deliver User Content solely to provide the Services: to show your
          store page to the people you send there, and to hand a file to the
          buyer who paid you for it. We do not use your files or your store&apos;s
          text to train anything, and we do not sell or license them to anyone.
        </p>
        <p>
          That license lasts as long as you keep the content on Marktmorgen. When you
          remove a product or close your store, it ends for the content removed.
        </p>
      </LegalSection>

      <LegalSection title="11. Disclaimer of warranties">
        <p>
          THE SERVICES ARE PROVIDED “AS IS” AND “AS AVAILABLE.” TO THE MAXIMUM
          EXTENT PERMITTED BY LAW, WE DISCLAIM ALL WARRANTIES, EXPRESS OR
          IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
          AND NON-INFRINGEMENT. We do not warrant that the Services will be
          uninterrupted, secure, or error-free.
        </p>
      </LegalSection>

      <LegalSection title="12. Limitation of liability">
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, MARKTMORGEN AND
          ITS OWNERS, OFFICERS, AND CONTRACTORS WILL NOT BE LIABLE FOR ANY
          INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR
          ANY LOSS OF PROFITS, DATA, OR GOODWILL, ARISING FROM YOUR USE OF THE
          SERVICES.
        </p>
        <p>
          OUR TOTAL LIABILITY FOR ANY CLAIM ARISING OUT OF THESE TERMS OR THE
          SERVICES WILL NOT EXCEED THE AMOUNT YOU PAID TO US IN THE THREE (3)
          MONTHS BEFORE THE CLAIM AROSE, OR US$50, WHICHEVER IS GREATER. Money
          a buyer paid into a creator&apos;s own Stripe account was never paid
          to us and is not part of that amount.
        </p>
        <p>
          Some jurisdictions do not allow certain limitations. In those cases,
          our liability is limited to the maximum extent permitted by law.
          Nothing in these Terms limits liability that cannot be limited under
          applicable mandatory law, including liability for fraud or willful
          misconduct.
        </p>
      </LegalSection>

      <LegalSection title="13. Indemnification">
        <p>
          You agree to indemnify and hold Marktmorgen harmless from claims
          arising out of your User Content, the products you sell through a
          Marktmorgen store, your use of the Services, or your violation of these
          Terms or applicable law.
        </p>
      </LegalSection>

      <LegalSection title="14. Termination">
        <p>
          We may suspend or terminate your access if you breach these Terms, if
          required by law, or if we discontinue the Services. Upon termination,
          your right to use the Services ends. Sections that by their nature
          should survive — including intellectual property, disclaimers,
          limitation of liability, and governing law — will survive.
        </p>
        <p>
          Before we suspend or close a store, we email its owner the reason
          and give them a chance to answer, unless the law, or an urgent risk
          to buyers, other users or the Services, requires us to act at once;
          in that case we email the reason as soon as we can. If we discontinue
          the Services, we give at least 30 days&apos; notice by email.
        </p>
      </LegalSection>

      <LegalSection title="15. Changes to these Terms">
        <p>
          We may update these Terms from time to time. The &ldquo;Last
          updated&rdquo; date at the top of this page will change when we do. Material changes
          will be posted on this page. Continued use of the Services after
          changes take effect constitutes acceptance of the updated Terms.
        </p>
      </LegalSection>

      <LegalSection title="16. Governing law">
        <p>
          These Terms are governed by the laws of the Federative Republic of
          Brazil, without regard to conflict-of-law rules. Courts located in
          Brazil will have exclusive jurisdiction, except that you may have
          additional mandatory consumer rights in your country of residence.
        </p>
      </LegalSection>

      <LegalSection title="17. Contact">
        <p>
          Marktmorgen
          <br />
          Email:{" "}
          <a
            href="mailto:support@marktmorgen.com"
            className="text-black underline underline-offset-2 hover:no-underline"
          >
            support@marktmorgen.com
          </a>
          <br />
          Website:{" "}
          <a
            href="https://marktmorgen.com"
            className="text-black underline underline-offset-2 hover:no-underline"
          >
            marktmorgen.com
          </a>
        </p>
      </LegalSection>
    </LegalPage>
  );
}
