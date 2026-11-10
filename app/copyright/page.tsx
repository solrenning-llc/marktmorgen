import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { COUNTER_NOTICE_DAYS } from "@/lib/takedown-hold";

export const metadata: Metadata = {
  title: "Copyright and Takedown Policy — Marktmorgen",
  description:
    "How to tell us that something on a Marktmorgen store infringes your copyright or is illegal, what we do about it, how a creator answers, and what happens to stores that infringe again.",
};

const link = "text-black underline underline-offset-2 hover:no-underline";

export default function CopyrightPage() {
  return (
    <LegalPage title="Copyright and Takedown Policy" lastUpdated="November 10, 2026" effective="October 9, 2026">
      <p>
        Marktmorgen hosts stores run by independent creators. Each creator is responsible for what they put on their
        store — the products, the pictures, the words, the links and anything played on the page — and our{" "}
        <Link href="/terms" className={link}>Terms of Service</Link> forbid anything that infringes someone else&apos;s
        rights. When something does, this is how to tell us, and what we do about it. We follow the notice-and-takedown
        procedure of the US Digital Millennium Copyright Act (17 U.S.C. § 512) and the notice-and-action rules of the EU
        Digital Services Act.
      </p>

      <LegalSection title="1. Telling us about copyright infringement">
        <p>
          Use the form at <Link href="/report" className={link}>marktmorgen.com/report</Link>, or write to our
          Copyright Agent at{" "}
          <a href="mailto:support@marktmorgen.com" className={link}>support@marktmorgen.com</a>. Every store page also
          has a &ldquo;Report a problem with this page&rdquo; link at its foot. A notice has to include:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>the copyrighted work you say was infringed, or a list of them;</li>
          <li>the page on Marktmorgen where the infringing material is, precise enough for us to find it;</li>
          <li>your name, a postal address or telephone number, and an email address;</li>
          <li>a statement that you believe in good faith that the use is not authorized by the copyright owner, its agent or the law;</li>
          <li>a statement that the information in the notice is accurate and, under penalty of perjury, that you are the owner or authorized to act for the owner;</li>
          <li>your physical or electronic signature (your typed full name is enough).</li>
        </ul>
        <p>The form asks for each of these, so a notice sent through it is complete.</p>
      </LegalSection>

      <LegalSection title="2. What we do with a notice">
        <p>
          We read every notice. When it is complete and points to material on a store, we remove it or disable access to it
          promptly — a link, a product, a media kit, or, where the whole store is the problem, the store&apos;s pages and
          sales. We email the creator what was taken down, the substance of the notice, and how to send a counter-notice,
          and we keep a record of it. A notice that is incomplete, or that points to nothing on our site, is answered and
          not acted on.
        </p>
      </LegalSection>

      <LegalSection title="3. Counter-notices">
        <p>
          A creator who believes material was taken down by mistake or misidentification can reply to the email we sent,
          with:
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>their name and physical or electronic signature;</li>
          <li>what was taken down and where it was before;</li>
          <li>a statement under penalty of perjury that they believe in good faith it was taken down by mistake or misidentification;</li>
          <li>their name, address and telephone number, and a statement that they consent to the jurisdiction of the federal district court for their address (or, if outside the United States, any judicial district in which Marktmorgen may be found) and will accept service of process from the person who sent the notice.</li>
        </ul>
        <p>
          We send a copy to the person who sent the notice. Unless they tell us within 10 business days that they have
          filed a court action to stop the infringement, we put the material back 10 to 14 business days after we received
          the counter-notice.
        </p>
        <p>
          A link taken down for a copyright notice, with its picture, is kept for {COUNTER_NOTICE_DAYS} days, hidden from
          everyone, so that we can put it back as it was. A counter-notice about it has to reach us within those{" "}
          {COUNTER_NOTICE_DAYS} days. If none does, or if the person who sent the notice tells us they have gone to court,
          the link and its picture are deleted when the {COUNTER_NOTICE_DAYS} days are over.
        </p>
      </LegalSection>

      <LegalSection title="4. Repeat infringers">
        <p>
          We switch off the pages and sales of a store that is the subject of repeated valid notices, and may close the
          account. Buyers keep what they already paid for: the links in their emails and their order page keep working,
          because a buyer did nothing wrong.
        </p>
      </LegalSection>

      <LegalSection title="5. Other illegal content">
        <p>
          For anything else you believe is illegal — in the European Union or anywhere else — use the same{" "}
          <Link href="/report" className={link}>form</Link> and choose &ldquo;Other illegal content&rdquo;. Say where it is
          and why it is illegal. We decide, act on it if it is, and tell the creator what we decided and why. A creator who
          disagrees can reply and ask us to look again, and we tell them the outcome.
        </p>
      </LegalSection>

      <LegalSection title="6. Music, video and podcasts played on a store">
        <p>
          A creator can play a video or a recording on their store page from YouTube, Vimeo, Loom, Spotify, SoundCloud,
          Apple Music or Apple Podcasts. It plays through that service&apos;s own player and from that service&apos;s own
          servers; nothing is copied to ours. If a recording there infringes your rights, report it to the service as well:
          once the service removes it, it stops playing on every site, ours included. Tell us too, and we take the link
          down from the store.
        </p>
      </LegalSection>

      <LegalSection title="7. Notices made in bad faith">
        <p>
          Under 17 U.S.C. § 512(f), anyone who knowingly misrepresents that material is infringing, or that it was taken
          down by mistake, may be liable for damages. Please make sure a notice is right before you send it.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
