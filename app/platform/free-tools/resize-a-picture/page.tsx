import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { PictureTool } from "@/components/free-tool-picture";
import { FREE_TOOLS, FREE_TOOLS_PATH } from "@/lib/free-tools";

const tool = FREE_TOOLS.find((t) => t.slug === "resize-a-picture")!;

export const metadata: Metadata = {
  title: `${tool.title} — Free tool — Marktmorgen`,
  description: tool.sentence,
  alternates: { canonical: "/platform/free-tools/resize-a-picture" },
};

/** 244 [SP1], unit 3: a picture resized for a product page, in the browser (components/free-tool-picture.tsx). */
export default function PicturePage() {
  return (
    <LegalPage title={tool.title} eyebrow="Free tool" effective={null} legalNav={false}>
      <p className="max-w-[70ch] text-lg">{tool.sentence}</p>
      <PictureTool />
      <p className="text-sm text-ink-soft">
        <Link href={FREE_TOOLS_PATH} prefetch={false} className="underline underline-offset-4">All free tools</Link>
        {" · "}
        Selling your own work? <Link href="/signin" prefetch={false} className="underline underline-offset-4">Start your store</Link>
      </p>
    </LegalPage>
  );
}
