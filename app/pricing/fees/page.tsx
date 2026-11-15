import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";
import { FeeSchedule } from "@/components/fee-schedule";
import { FEES_CHECKED_ON, checkedOnWords } from "@/lib/fee-schedule";

export const metadata: Metadata = {
  title: "Fees — Marktmorgen",
  description: "Every fee in a sale through Marktmorgen: the plan price, Stripe's card, currency, dispute and payout fees by country, and who pays each, with sources.",
  alternates: { canonical: "/pricing/fees" },
};

/**
 * 253 [WH2]. The page is built at each deploy, so the 90-day check in
 * lib/fee-schedule.ts is read then: main deploys many times a day.
 */
export default function FeesPage() {
  return (
    <LegalPage title="Every fee, in one place" eyebrow="What a sale costs" effective={null} legalNav={false} lastUpdated={checkedOnWords(FEES_CHECKED_ON)}>
      <FeeSchedule />
    </LegalPage>
  );
}
