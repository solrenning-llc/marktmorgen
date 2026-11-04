"use client";

import { useMemo } from "react";
import QRCode from "qrcode";
import { toast } from "@/components/toast";
import { qrFileName, qrSvg } from "@/lib/share-links";

/**
 * For buyers a creator meets in person (636 [GL4](b); owner's HighLevel
 * audit): a QR code and the address of the store's purchases page, to print
 * or show at a table. It never opens a review form by itself: the buyer types
 * the email they paid with, gets their purchases by email, and reviews from
 * there, so only someone who really bought can review, exactly as online.
 *
 * Drawn here from the code's grid as squares (lib/share-links.ts qrSvg),
 * never from markup handed in; downloaded as an SVG for print.
 */
export function ReviewQr({ url, storeName }: { url: string; storeName: string }) {
  const svg = useMemo(() => {
    try {
      const code = QRCode.create(url, { errorCorrectionLevel: "M" });
      return qrSvg(Array.from(code.modules.data, Boolean), code.modules.size);
    } catch {
      return "";
    }
  }, [url]);
  const image = svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : "";

  return (
    <div>
      <p className="text-sm text-ink-soft">
        Show or print this where you meet buyers. It opens your purchases page: a buyer types the email they paid with, gets
        their purchases by email, and reviews from there. Only people who bought can review, and every review counts the
        same, whatever its stars.
      </p>
      {image ? (
        <div className="mt-3 flex flex-wrap items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image} alt={`QR code that opens the purchases page of ${storeName}`} width={132} height={132} className="rounded-lg ring-1 ring-line" />
          <div className="min-w-0 space-y-2">
            <p className="break-all font-mono text-xs text-ink">{url}</p>
            <div className="flex flex-wrap gap-2">
              <a href={image} download={qrFileName(`${storeName} reviews`, "svg")} className="btn btn-secondary">
                Download the QR code
              </a>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  navigator.clipboard?.writeText(url).then(
                    () => toast("Link copied."),
                    () => toast("Copy the link from the line above."),
                  );
                }}
              >
                Copy the link
              </button>
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-ink-soft" role="status">The QR code could not be drawn here. The link is {url}.</p>
      )}
    </div>
  );
}
