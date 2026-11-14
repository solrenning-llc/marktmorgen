import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Trust and safety — Marktmorgen",
  description: "How publication checks, buyer reviews and content reports work, and where to get help with a purchase.",
};

const link = "text-black underline underline-offset-2 hover:no-underline";

export default function TrustAndSafetyPage() {
  return (
    <LegalPage title="Trust and safety" eyebrow="Help for buyers and creators" effective={null} legalNav={false}>
      <p>
        These are the checks and reporting paths available on Marktmorgen. They help people make informed choices,
        but cannot guarantee that an offer is accurate or that a purchase will meet your expectations.
      </p>

      <LegalSection title="1. Publication checks">
        <p>
          Product titles, summaries, descriptions and sales-page text are checked for promises of fast or easy money
          when a creator publishes a product or edits its published content. A detected promise stops that publication
          and shows the creator the passage to change. The check does not rewrite the creator&apos;s words.
        </p>
        <p>
          Automated checks may miss misleading wording. Read the description, what is included and the creator&apos;s
          refund policy before buying. A published page is not a guarantee of earnings or results.
        </p>
      </LegalSection>

      <LegalSection title="2. Buyer reviews">
        <p>
          Product reviews are linked to a paid purchase checked with the creator&apos;s payment account. Creators can
          reply, but cannot rewrite a buyer&apos;s review or change its stars. A buyer can edit or delete their own review.
        </p>
        <p>
          A creator may hide review text only for the review rules, such as private information, abuse or unlawful
          content. Those rules apply to every rating. Hiding text does not remove its stars from the average; the
          product page shows how many reviews the creator has hidden.
        </p>
      </LegalSection>

      <LegalSection title="3. Report copyright infringement or illegal content">
        <p>
          Use the <Link href="/report" className={link}>Report copyright infringement or illegal content</Link> form.
          Include the page address and explain the problem. The form tells you what information is needed and how
          notice details may be shared with the creator.
        </p>
        <p>
          Our <Link href="/copyright" className={link}>Copyright and Takedown Policy</Link> explains notices,
          counter-notices and repeat infringement. Our <Link href="/terms" className={link}>Terms of Service</Link>{" "}
          explain what creators may sell and the account rules.
        </p>
      </LegalSection>

      <LegalSection title="4. Get help with a purchase">
        <p>
          For a missing item, trouble accessing a purchase or a refund request, start with{" "}
          <Link href="/help/buyers" className={link}>Help for buyers</Link>. It explains how to find your purchase,
          contact the creator and use the store&apos;s refund policy. Keep your receipt so you can identify the order.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
