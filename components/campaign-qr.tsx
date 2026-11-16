"use client";

import { useMemo } from "react";
import { toast } from "@/components/toast";
import { campaignQr, campaignQrTag } from "@/lib/campaign-qr";

/**
 * A campaign's QR code for events and printed material (632 [AA2](q)): the
 * page with the campaign's own tag (lib/campaign-qr.ts), so scans and the
 * sales after them count under the same campaign in the studio's numbers.
 * Drawn here from the code's grid, never from markup handed in, and
 * downloaded as an SVG with a title for print.
 */
export function CampaignQr({ url, title, campaign, content = "" }: { url: string; title: string; campaign: string; content?: string }) {
  const code = useMemo(() => campaignQr(url, campaign, title, content), [url, campaign, title, content]);
  // Each refusal said as what it is: "personal" (an address or phone number), or "empty" (no letters or numbers).
  const nameTag = campaignQrTag(campaign);
  const variantTag = content.trim() !== "" ? campaignQrTag(content) : null;
  const personalName = "refused" in nameTag && nameTag.refused === "personal";
  const nameOk = "tag" in nameTag;
  const personalVariant = nameOk && variantTag !== null && "refused" in variantTag && variantTag.refused === "personal";
  const emptyVariant = nameOk && variantTag !== null && "refused" in variantTag && variantTag.refused === "empty";

  if (!code) {
    return (
      <p className="text-sm text-ink-soft" role="status">
        {personalName
          ? "No QR code for this name: it looks like an email address or phone number, and the code is printed for anyone to read. Use a campaign name instead, like spring-fair."
          : personalVariant
            ? "No QR code for this variant: it looks like an email address or phone number, and the code is printed for anyone to read. Change the variant, or leave it empty."
            : emptyVariant
              ? "No QR code for this variant: it has no letters or numbers. Change the variant, or leave it empty."
              : "The QR code could not be drawn for this name. Use a campaign name with letters or numbers, like spring-fair."}
      </p>
    );
  }
  const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code.svg)}`;

  return (
    <div className="flex flex-wrap items-start gap-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image} alt={code.label} width={132} height={132} className="rounded-lg ring-1 ring-line" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-semibold text-ink">QR code for this campaign</p>
        <p className="text-sm text-ink-soft">
          Print it for events, flyers and posters. Visits from a scan, and payments started from that visit, count under the
          same campaign tag as this link, with QR code as the channel.
        </p>
        <p className="break-all font-mono text-xs text-ink">{code.link}</p>
        <div className="flex flex-wrap gap-2">
          <a href={image} download={code.fileName} className="btn btn-secondary">
            {`Download the QR code for ${code.tag} (SVG)`}
          </a>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              navigator.clipboard?.writeText(code.link).then(
                () => toast("Link copied."),
                () => toast("Copy the link from the line above."),
              );
            }}
          >
            Copy the QR link
          </button>
        </div>
      </div>
    </div>
  );
}
