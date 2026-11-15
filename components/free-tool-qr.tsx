"use client";

/**
 * 244 [SP1], unit 2: a QR code for a web address, made in the visitor's
 * browser from the code's own grid (lib/free-tool-qr.ts qrForLink). Nothing is
 * sent or kept: the picture and the file to download are made on this page.
 */
import { useId, useState } from "react";
import { MAX_QR_LINK, qrForLink } from "@/lib/free-tool-qr";

export function QrTool() {
  const [link, setLink] = useState("");
  const help = useId();
  const made = qrForLink(link);
  const problem = link.trim() !== "" && !made ? "That is not a web address we can make a code for. Type one like https://example.com/your-page." : "";
  const src = made ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(made.svg)}` : "";

  return (
    <div className="space-y-6">
      <p id={help} className="max-w-[70ch]">
        The code is made in your browser, and nothing you type leaves this page. Scan it with your phone before you print it.
      </p>
      <form className="max-w-xl" onSubmit={(e) => e.preventDefault()} noValidate>
        <label htmlFor="qr-link" className="field-label">Web address</label>
        <input
          id="qr-link"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={MAX_QR_LINK}
          aria-describedby={help}
          value={link}
          onChange={(e) => setLink(e.target.value)}
          className="field mt-2 w-full"
        />
      </form>
      {problem ? (
        <p className="notice notice-warn max-w-xl text-ink" aria-live="polite">{problem}</p>
      ) : null}
      <output aria-live="polite" htmlFor="qr-link" className="block max-w-xl">
        {made ? (
          <span className="grid justify-items-start gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- a drawing made on this page, not a file to optimize */}
            <img src={src} alt={`QR code that opens ${made.link}`} width={240} height={240} className="rounded-xl ring-1 ring-line" />
            <a href={src} download={made.fileName} className="btn btn-secondary">Download the QR code (SVG)</a>
          </span>
        ) : (
          <span>Type a web address to see its code.</span>
        )}
      </output>
    </div>
  );
}
