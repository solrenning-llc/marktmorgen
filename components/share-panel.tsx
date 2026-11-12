"use client";

import { useEffect, useId, useMemo, useState } from "react";
import QRCode from "qrcode";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { CAMPAIGN_MEDIA, type CampaignMedium, campaignLink, POST_PLACES, postName, qrFileName, qrSvg, shareLinks, taggedFor } from "@/lib/share-links";
import { NewTab } from "@/components/new-tab";
import { CampaignQr } from "@/components/campaign-qr";

/**
 * Sharing a page (added 8 October 2026): its address to copy, a QR code to
 * print or put on a slide, and each network's own page to post it from,
 * every link tagged with where it went (lib/share-links.ts) so the studio's
 * numbers say which place brought the visits.
 *
 * The QR code is drawn here from the code's grid, as squares, never from
 * markup handed in, and downloaded as an SVG for print or a PNG for slides.
 */
export function SharePanel({ url, title, what = "page" }: { url: string; title: string; what?: string }) {
  const panelId = useId();
  const qrUrl = taggedFor(url, "qr");
  const grid = useMemo(() => {
    try {
      const code = QRCode.create(qrUrl, { errorCorrectionLevel: "M" });
      return { size: code.modules.size, modules: Array.from(code.modules.data, Boolean) };
    } catch {
      return null;
    }
  }, [qrUrl]);
  const svg = grid ? qrSvg(grid.modules, grid.size) : "";
  const [canShare, setCanShare] = useState(false);
  const [postPlace, setPostPlace] = useState("instagram");
  const [post, setPost] = useState("");
  const [postMedium, setPostMedium] = useState<CampaignMedium>("post");
  const [postContent, setPostContent] = useState("");
  const forPost = postName(post) ? campaignLink(url, postPlace, post, postMedium, postContent) : "";
  useEffect(() => {
    const id = window.setTimeout(() => setCanShare(typeof navigator.share === "function"), 0);
    return () => window.clearTimeout(id);
  }, []);

  function save(blob: Blob, name: string) {
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
  }

  function savePng() {
    if (!grid) return;
    const scale = 16;
    const quiet = 4;
    const full = (grid.size + quiet * 2) * scale;
    const canvas = document.createElement("canvas");
    canvas.width = full;
    canvas.height = full;
    const pen = canvas.getContext("2d");
    if (!pen) return;
    pen.fillStyle = "#ffffff";
    pen.fillRect(0, 0, full, full);
    pen.fillStyle = "#000000";
    for (let y = 0; y < grid.size; y += 1) {
      for (let x = 0; x < grid.size; x += 1) {
        if (grid.modules[y * grid.size + x]) pen.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
    }
    canvas.toBlob((blob) => {
      if (blob) save(blob, qrFileName(title, "png"));
    }, "image/png");
  }

  async function copy(text = url) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Link copied.");
    } catch {
      toast("Select the link and copy it.");
    }
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 space-y-4">
        <div>
          <label htmlFor={`${panelId}-share-url`} className="field-label">
            {`Link to this ${what}`}
          </label>
          <div className="flex flex-wrap gap-2">
            <textarea rows={2} id={`${panelId}-share-url`} className="field min-w-0 flex-1 resize-y whitespace-pre-wrap [overflow-wrap:anywhere]" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" onClick={() => void copy()} className="btn btn-secondary">
              <Icon name="copy" size={16} />
              Copy
            </button>
          </div>
        </div>
        <div>
          <p className="field-label">Post it</p>
          <div className="flex flex-wrap gap-2">
            {shareLinks(url, title).map((link) => (
              <a key={link.place} href={link.href} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm ring-1 ring-line">
                {link.label}
              <NewTab /></a>
            ))}
            {canShare ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm ring-1 ring-line"
                onClick={() => {
                  navigator.share({ title, url: taggedFor(url, "device") }).catch(() => {});
                }}
              >
                More…
              </button>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-ink-soft">
            Each opens that site&apos;s own page to post from, with the words in; nothing is posted for you. Each link is tagged, so your numbers show which one brought visitors and sales.
          </p>
        </div>
        <div>
          <p className="field-label">A link for a post or ad</p>
          <div className="flex flex-wrap gap-2">
            <label className="sr-only" htmlFor={`${panelId}-share-post-place`}>
              Where the link goes
            </label>
            <select id={`${panelId}-share-post-place`} className="field w-auto" value={postPlace} onChange={(e) => setPostPlace(e.target.value)}>
              {POST_PLACES.map((p) => (
                <option key={p.place} value={p.place}>
                  {p.label}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor={`${panelId}-share-post-name`}>
              Campaign name
            </label>
            <input
              id={`${panelId}-share-post-name`}
              className="field min-w-0 flex-1"
              placeholder="A campaign name, like summer-launch"
              maxLength={60}
              value={post}
              onChange={(e) => setPost(e.target.value)}
            />
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label htmlFor={`${panelId}-share-post-medium`} className="text-sm">
              <span className="field-label">Link type</span>
              <select id={`${panelId}-share-post-medium`} className="field mt-1" value={postMedium} onChange={(e) => setPostMedium(e.target.value as CampaignMedium)}>
                {CAMPAIGN_MEDIA.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
            <label htmlFor={`${panelId}-share-post-content`} className="text-sm">
              <span className="field-label">Ad or link variant (optional)</span>
              <input id={`${panelId}-share-post-content`} className="field mt-1" placeholder="Like reel-a or headline-b" maxLength={60} value={postContent} onChange={(e) => setPostContent(e.target.value)} />
            </label>
          </div>
          {forPost ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <textarea rows={2} aria-label="Campaign link" className="field min-w-0 flex-1 resize-y whitespace-pre-wrap [overflow-wrap:anywhere]" readOnly value={forPost} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" onClick={() => void copy(forPost)} className="btn btn-secondary">
                <Icon name="copy" size={16} />
                Copy
              </button>
            </div>
          ) : null}
          {forPost ? (
            <div className="mt-3">
              <CampaignQr url={url} title={title} campaign={post} content={postContent} />
            </div>
          ) : null}
          <p className="mt-1 text-xs text-ink-soft">
            Use this link in the post, email or ad. Your numbers use the campaign tag for visits and paid records, and the optional variant for ad records. Names are normalized to the displayed link and capped at 40 characters; use the same campaign tag when recording ad spend. Existing tracking tags are replaced, while other query values and page anchors are preserved.
          </p>
        </div>
      </div>
      <figure className="flex flex-col items-center gap-2">
        {svg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={`QR code that opens ${title}`} width={148} height={148} className="rounded-lg ring-1 ring-line" />
        ) : null}
        <figcaption className="text-center text-xs text-ink-soft">For print, slides and talks</figcaption>
        <div className="flex gap-2">
          <button type="button" className="btn btn-ghost btn-sm ring-1 ring-line" disabled={!svg} onClick={() => save(new Blob([svg], { type: "image/svg+xml" }), qrFileName(title, "svg"))}>
            <Icon name="download" size={15} />
            SVG
          </button>
          <button type="button" className="btn btn-ghost btn-sm ring-1 ring-line" disabled={!grid} onClick={savePng}>
            <Icon name="download" size={15} />
            PNG
          </button>
        </div>
      </figure>
    </div>
  );
}
