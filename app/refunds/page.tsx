import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { REFUND_DAYS, TRIAL_DAYS } from "@/lib/plan";
import { PLANS_ON_SALE } from "@/lib/opening";
import { CLOSING_DAYS } from "@/lib/plan-closing-rules";

export const metadata: Metadata = {
  title: "Refund Policy — Marktmorgen",
  description:
    `Cancel anytime. Within ${REFUND_DAYS} days of your first payment, it and every plan payment since for the same store refunded in full on request; a yearly plan refunded for the months not yet started, less Stripe's card fee.`,
};

export default function RefundsPage() {
  return (
    <LegalPage title="Refund Policy" lastUpdated="October 31, 2026">
      <p>
        This Refund Policy applies to what you pay Marktmorgen, a product of
        Solrenning, an independent software studio, for the creator store at
        marktmorgen.com: the monthly
        or yearly subscription, on any plan, at the price shown at
        checkout.
      </p>
      <p>
        It does not cover something you bought from a creator&apos;s store.
        That money went straight into that creator&apos;s own Stripe account
        and never passed through us, so the refund is theirs to give. Section 7
        says what to do.
      </p>

      <LegalSection id="cancel" title="1. Cancel anytime">
        <p>
          You may cancel your subscription at any time, for any reason, with no
          questions asked. After you cancel, you will not be charged for future
          billing periods. You will keep access until the end of the period you
          have already paid for, unless you also request a refund as described
          below.
        </p>
        <p>
          To cancel, open your studio and choose &ldquo;Cancel the
          subscription&rdquo; under &ldquo;What you pay us,&rdquo; then
          &ldquo;Yes, cancel it.&rdquo; You can also
          ask us by email, as described in section 4.
        </p>
      </LegalSection>

      <LegalSection id="guarantee" title={`2. ${REFUND_DAYS}-day money-back guarantee from your first payment`}>
        <p>
          If you request a refund within thirty ({REFUND_DAYS}) days of the
          first payment on your account, we will refund that payment in full,
          and in full every other payment for the same store&apos;s plan made
          since then, within those days, such as a monthly renewal or a charge
          for switching plans. No reason is required and none will be asked
          for. The first payment is the first charge we make to you, on any
          plan, monthly or yearly, for any of your stores. The guarantee is
          given once per person: a payment is not a first payment when the
          same person, by email address or by card, has paid us before.
        </p>
        <p>
          This guarantee covers what happens once you have actually been
          charged, whether or not you qualified for a trial. An eligible first
          store can receive a {TRIAL_DAYS}-day trial when you choose a plan
          separately in your studio; returning and additional stores may not
          qualify. If a trial applies, canceling before it ends prevents the
          first plan charge.
        </p>
        <p>
          A refund ends the plan of the store it was for on the day it is
          made: its checkout stops taking payments, and the other paid
          features of the plan stop with it. The store then stays as it is
          for {CLOSING_DAYS} days and closes after that, as{" "}
          <Link href="/terms#closing" className="text-black underline underline-offset-2 hover:no-underline">
            section 8 of our Terms
          </Link>{" "}
          says; starting a plan again before then keeps it. When it closes,
          the renewals of the memberships and payment plans you sold through
          it are stopped at Stripe, each at the end of the period already
          paid. Every sale, refund and payout stays on your own Stripe
          account: that money was never ours to return.
        </p>
        {!PLANS_ON_SALE ? (
          <p>
            Paid plans are not on sale yet. Preparing a store today does not
            start a paid plan or an active trial.
          </p>
        ) : null}
      </LegalSection>
      <LegalSection id="yearly" title="3. Yearly plans: the months you have not started">
        <p>
          A yearly plan can be refunded at any time, not only in its first{" "}
          {REFUND_DAYS} days. We keep the months that have started, each at
          the monthly price of that plan, and the card processing fee Stripe
          charged on the yearly payment, which Stripe does not give back to us
          when a payment is refunded; the rest of what you paid comes back.
          So a yearly plan refunded in its second month costs you two months at
          the monthly price and that fee, and the other ten months come back.
          Its plan ends on the day of the refund, as section 2 says.
        </p>
        <p>
          If the yearly payment was your first payment to us, or was made for
          the same store&apos;s plan within {REFUND_DAYS} days of it, and you
          ask within {REFUND_DAYS}{" "}
          days of your first payment, section 2 applies instead and the whole
          payment comes back.
        </p>
      </LegalSection>
      <LegalSection title="4. How to request a cancellation or refund">
        <p>
          <strong className="text-black">In your studio.</strong> Under
          &ldquo;What you pay us,&rdquo; choose &ldquo;Refund my
          payment.&rdquo; A review page shows the exact amount this policy
          gives you today and what happens to your store, before anything
          changes; nothing is refunded until you confirm there, and you can go
          back without changing anything. Only the store&apos;s owner can ask
          for it. When you confirm, the payment is refunded, the plan ends, and
          we email you the amount. If the page says it cannot work out your
          refund, or you cannot use it, write to us as below.
        </p>
        <p>
          <strong className="text-black">By email.</strong> Email{" "}
          <a
            href="mailto:support@marktmorgen.com"
            className="text-black underline underline-offset-2 hover:no-underline"
          >
            support@marktmorgen.com
          </a>{" "}
          from the email address associated with your account. Please include:
        </p>
        <ul className="list-disc pl-6 space-y-2">
          <li>the email on the account;</li>
          <li>whether you want to cancel, request a refund, or both; and</li>
          <li>the date of the charge, if you are requesting a refund.</li>
        </ul>
        <p>
          We will confirm by email once your cancellation, refund, or both
          have been processed. Refunds are returned to the original payment method and
          may take several business days to appear, depending on your bank or
          card issuer.
        </p>
      </LegalSection>

      <LegalSection title="5. Renewals and later charges">
        <p>
          After the {REFUND_DAYS} days of section 2, a monthly renewal, a
          charge made when you switch plans and any other later charge are not
          refunded, except where applicable consumer law requires it. You may cancel at any time to
          stop future charges and keep access until the end of the period you
          have already paid for. The months of a yearly plan that have not
          started are always refunded, as section 3 says.
        </p>
        <p>
          Why the guarantee is only for your first {REFUND_DAYS} days: a refund
          gives back the whole month after it has been used, including what
          that month cost us to serve. We offer that once, so you can try the
          paid plan for real; offering it on every month would make every month
          free for anyone who asked, and the plans would have to cost everyone
          else more.
        </p>
      </LegalSection>
      <LegalSection id="store-assistant" title="5a. The Store assistant add-on">
        <p>
          The Store assistant is a subscription of its own, beside your plan.
          Its payments, the first one included, are not refunded, except where
          applicable consumer law requires it: the money-back guarantee above
          is for your plan&apos;s payments. You can stop it at any time
          from your studio, and it stays on until the end of the month already
          paid. If your plan ends, it is set to stop at the end of the month
          already paid, and nothing more is charged for it.
        </p>
      </LegalSection>
      <LegalSection title="6. Chargebacks">
        <p>
          If you have a billing issue, please contact us first so we can help.
          Unwarranted chargebacks may result in account suspension.
        </p>
      </LegalSection>

      <LegalSection title="7. If you bought from a creator’s store">
        <p>
          Write to the creator you bought from: reply to the confirmation email
          the store sent you after you paid, and your reply reaches them. Their
          store is theirs: they
          set the terms of the sale, they received the money in their own
          Stripe account, and they are the only one who can return it.
        </p>
        <p>
          If you bought something you could open right away, the checkout
          asked you to check a box saying it may start before your 14-day right
          to cancel ends, and that you lose that right once access starts.
          Where the law where you live gives that right, as in the European
          Union and the United Kingdom, it ended when your access started; for
          a pre-order, it lasts until the release day, and an item shipped to
          you keeps its own right from the day you receive it. For a
          membership, the box asked for it to start now: if you cancel within
          14 days of joining, you keep that right and pay only for what you
          were given until then. The confirmation email quotes the box you
          checked. The creator may still agree to a refund, and their own
          terms, and the law, still apply to anything that was not as
          described or did not work.
        </p>
        <p id="store-closes">
          <strong className="text-black">If the store closes.</strong>{" "}
          From the day the store&rsquo;s plan ends, we pause the payments of
          a membership or payment plan you have there, so you are not charged
          again, unless the store is past its closing&rsquo;s limit or Stripe
          does not let us pause yours; the creator is then told and asked to
          refund any charge (see our{" "}
          <Link href="/terms#closing-members" className="text-black underline underline-offset-2 hover:no-underline">
            Terms
          </Link>
          ). On the day the
          store closes, the part of your last payment that paid for time after
          that day is refunded to you automatically from the creator&rsquo;s
          own Stripe account, if its balance covers it, unless the creator
          already refunded it. Marktmorgen does not hold that money and never
          pays it. If the balance does not cover it, the refund is not made,
          and we email you to say so, with the creator&rsquo;s contact. If the
          creator keeps the store open, nothing is refunded and your
          membership goes on as it was, with nothing charged for the days in
          between.
        </p>
        <p>
          If you cannot reach them, write to us at{" "}
          <a
            href="mailto:support@marktmorgen.com"
            className="text-black underline underline-offset-2 hover:no-underline"
          >
            support@marktmorgen.com
          </a>{" "}
          with your order confirmation email. We cannot move money we never held, but we can
          pass your message to the creator and tell you what we did.
        </p>
      </LegalSection>

      <LegalSection title="8. Changes">
        <p>
          We may update this Refund Policy. The &ldquo;Last updated&rdquo; date at
          the top of this page will change when we do. The policy in effect at the
          time of a charge will apply to that charge.
        </p>
      </LegalSection>

      <LegalSection title="9. Contact">
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
