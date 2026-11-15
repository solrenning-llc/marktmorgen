import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { FreeToolsHub } from "@/components/free-tools-hub";

export const metadata: Metadata = {
  title: "Free tools for creators — Marktmorgen",
  description: "Free tools for creators that work in your browser, with no sign-up and nothing sent anywhere.",
  alternates: { canonical: "/platform/free-tools" },
};

/** 244 [SP1]: the free tools, each on its own page (lib/free-tools.ts). */
export default function FreeToolsPage() {
  return (
    <LegalPage title="Free tools for creators" eyebrow="No sign-up, nothing sent" effective={null} legalNav={false}>
      <p className="max-w-[70ch] text-lg">Each tool works in your browser. You do not need an account, and nothing you type is sent to us or kept.</p>
      <FreeToolsHub />
      <p className="text-sm text-ink-soft">
        Selling your own work? <Link href="/signin" prefetch={false} className="underline underline-offset-4">Start your store</Link>
      </p>
    </LegalPage>
  );
}
