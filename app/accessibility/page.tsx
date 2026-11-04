import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { ACCESSIBILITY_CHECKS, STATEMENT_REVIEW, accessibilityGaps, reviewCounts } from "@/lib/accessibility-statement";

export const metadata: Metadata = {
  title: "Accessibility — Marktmorgen",
  description: "Our accessibility goal, what we test and how, what is still open, and how to tell us about a problem. No accessibility widget or overlay.",
};

const link = "text-black underline underline-offset-2 hover:no-underline";
const WCAG = <abbr title="Web Content Accessibility Guidelines">WCAG</abbr>;

/**
 * The accessibility statement (310 [AX2] §6, DA1). Every list on it comes from
 * the records (lib/accessibility-statement.ts); tests/accessibility-statement.test.ts
 * fails when it says more than they prove.
 */
export default function AccessibilityPage() {
  const gaps = accessibilityGaps();
  const { total, reviewed } = reviewCounts();
  return (
    <LegalPage title="Accessibility" eyebrow="What we test, and what is still open" lastUpdated={STATEMENT_REVIEW.date} effective={null} legalNav={false}>
      <p>
        We want everyone to be able to build a store with Marktmorgen and to buy from one, including people who use a
        screen reader, a keyboard, voice control, zoom or high contrast. This page says what we aim for, what we test,
        what is still open, and how to tell us about a problem.
      </p>

      <LegalSection title="1. Our goal">
        <p>
          Our goal is level AAA, the highest level of {WCAG} 2.2, on every page we make. We treat level AA as the
          floor, not the aim. This is a goal we work toward, not a claim that every page already meets it: the open
          items below say where we are not there yet.
        </p>
      </LegalSection>

      <LegalSection title="2. No widget or overlay">
        <p>
          Marktmorgen uses no accessibility widget or overlay: no button that promises to make a page accessible by
          itself. Those tools do not fix the page underneath. We do the work in the code of each page instead.
        </p>
      </LegalSection>

      <LegalSection title="3. What we test on each change">
        <p>
          These automated tests run on each proposed change to the site before it is merged, and once every day.
          Automated tests catch many problems, not all of them.
        </p>
        <ul className="list-disc space-y-2 pl-6">
          {ACCESSIBILITY_CHECKS.map((check) => (
            <li key={check.name}>
              <strong>{check.name}.</strong> {check.what}
            </li>
          ))}
        </ul>
      </LegalSection>

      <LegalSection title="4. What is still open">
        <p>{`Our records list ${total} kinds of page. ${total - reviewed} of ${total} still wait for a full review at level AAA, by a person, in every state the page can be in.`}</p>
        <p>These items are open in our records today:</p>
        <ul className="list-disc space-y-2 pl-6">
          {gaps.map((gap) => (
            <li key={gap.area}>{gap.words}</li>
          ))}
        </ul>
        <p>
          If something on a page stops you, write to us (section 6) and tell us what you were trying to do. We will
          look for another way to help you finish it, for example by email.
        </p>
      </LegalSection>

      <LegalSection title="5. Creators' stores">
        <p>
          Each creator is responsible for what they publish on their store: their pictures, videos, words and colors.
          The studio helps: its &ldquo;Can everyone use your store?&rdquo; panel lists the products on a store&apos;s
          first page whose picture has no description, so the creator can add one. We never change a creator&apos;s
          content for them. We do not promise that every store is accessible.
        </p>
      </LegalSection>

      <LegalSection title="6. Tell us about a problem">
        <p>
          Write to <a href="mailto:support@marktmorgen.com" className={link}>support@marktmorgen.com</a>. It helps us
          to know the page, what you were trying to do, your device and browser, and any assistive technology you use,
          such as a screen reader.
        </p>
      </LegalSection>

      <LegalSection title="7. Words on this page">
        <dl className="space-y-3">
          <div>
            <dt className="font-semibold">{WCAG}</dt>
            <dd>The Web Content Accessibility Guidelines, published by the World Wide Web Consortium (W3C). Level A is the lowest, AA the middle and AAA the highest.</dd>
          </div>
          <div>
            <dt className="font-semibold">Screen reader</dt>
            <dd>Software that reads what is on the screen aloud, or shows it in braille, for people who cannot see it.</dd>
          </div>
          <div>
            <dt className="font-semibold">NVDA, VoiceOver, JAWS, TalkBack</dt>
            <dd>Names of screen readers: NVDA (NonVisual Desktop Access) and JAWS (Job Access With Speech) run on Windows, VoiceOver on Apple devices and TalkBack on Android phones.</dd>
          </div>
          <div>
            <dt className="font-semibold">Chromium, Firefox, WebKit</dt>
            <dd>The engines inside the main web browsers: Chromium in Chrome and Edge, Firefox in Firefox, WebKit in Safari.</dd>
          </div>
          <div>
            <dt className="font-semibold">Forced colors</dt>
            <dd>A setting, such as Windows high contrast, that makes every page use a few colors the person chose.</dd>
          </div>
          <div>
            <dt className="font-semibold">Overlay</dt>
            <dd>A widget added on top of a website that claims to make it accessible without changing the site itself.</dd>
          </div>
        </dl>
        <p>
          Our other policies: <Link href="/terms" className={link}>Terms of Service</Link> and{" "}
          <Link href="/privacy" className={link}>Privacy Policy</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
