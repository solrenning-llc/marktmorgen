import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { TakeHomeTool } from "@/components/free-tool-take-home";
import { FREE_TOOLS, FREE_TOOLS_PATH } from "@/lib/free-tools";

const tool = FREE_TOOLS.find((t) => t.slug === "what-is-left-of-a-sale")!;

export const metadata: Metadata = {
  title: `${tool.title} — Free tool — Marktmorgen`,
  description: tool.sentence,
  alternates: { canonical: "/platform/free-tools/what-is-left-of-a-sale" },
};

/** 244 [SP1]: what is left of one sale, worked out in the browser (components/free-tool-take-home.tsx). */
export default function TakeHomePage() {
  return (
    <LegalPage title={tool.title} eyebrow="Free tool" effective={null} legalNav={false}>
      <p className="max-w-[70ch] text-lg">{tool.sentence}</p>
      <TakeHomeTool />
      <p className="text-sm text-ink-soft">
        <Link href={FREE_TOOLS_PATH} prefetch={false} className="underline underline-offset-4">All free tools</Link>
        {" · "}
        Selling your own work? <Link href="/signin" prefetch={false} className="underline underline-offset-4">Start your store</Link>
      </p>
    </LegalPage>
  );
}
