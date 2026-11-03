"use client";

import { useMemo, useState } from "react";
import QRCode from "qrcode";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { POST_PLACES, qrFileName, qrSvg } from "@/lib/share-links";
import { type LinkTarget, MAX_LINKS, MAX_NAME, type ShortLink, linkName, shortUrl } from "@/lib/short-link-rules";
import { formatMoney } from "@/lib/money";

type Result = { visits: number; sales: number; cents: number };

const REASONS: Record<string, string> = {
  name: "Give the post a name, like october-reel.",
  taken: "Another link already has that name. Each post's link needs its own, so its results are its own.",
  target: "Choose where the link goes.",
  full: `A store can have ${MAX_LINKS} links. End one you no longer use to make another.`,
};

const placeName = (place: string) => POST_PLACES.find((p) => p.place === place)?.label ?? "Somewhere else";
const targetValue = (t: LinkTarget) => (t.kind === "store" ? "store" : t.kind === "product" ? `product:${t.id}` : `cart:${t.ids.join(",")}:${t.code ?? ""}`);
/** A ready cart (made under "A link to a ready cart", 624 [SZ8](23)) is kept as it is when it stays chosen; the list offers it only as the link's own. */
const targetFrom = (value: string): LinkTarget => {
  if (value.startsWith("product:")) return { kind: "product", id: value.slice(8) };
  if (value.startsWith("cart:")) {
    const [ids = "", code = ""] = value.slice(5).split(":");
    return code ? { kind: "cart", ids: ids.split(","), code } : { kind: "cart", ids: ids.split(",") };
  }
  return { kind: "store" };
};

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

/** One link's QR code, drawn from the code's grid, to download for print or slides. */
function LinkQr({ url, name }: { url: string; name: string }) {
  const grid = useMemo(() => {
    try {
      const code = QRCode.create(url, { errorCorrectionLevel: "M" });
      return { size: code.modules.size, modules: Array.from(code.modules.data, Boolean) };
    } catch {
      return null;
    }
  }, [url]);
  if (!grid) return null;
  const svg = qrSvg(grid.modules, grid.size);
  const png = () => {
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
      if (blob) save(blob, qrFileName(name, "png"));
    }, "image/png");
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={`QR code that opens the link for ${name}`} width={112} height={112} className="rounded-lg ring-1 ring-line" />
      <div className="flex gap-2">
        <button type="button" className="btn btn-ghost btn-sm ring-1 ring-line" onClick={() => save(new Blob([svg], { type: "image/svg+xml" }), qrFileName(name, "svg"))}>
          <Icon name="download" size={15} />
          SVG
        </button>
        <button type="button" className="btn btn-ghost btn-sm ring-1 ring-line" onClick={png}>
          <Icon name="download" size={15} />
          PNG
        </button>
      </div>
    </div>
  );
}

/**
 * Short links for posts (lib/short-links.ts): one for each post, video, talk
 * or flyer, with its own QR code and its own line of results, and where it
 * goes changed here without editing the post.
 */
export function ShortLinks({
  links: given,
  products,
  results,
  currency,
}: {
  links: ShortLink[];
  products: { id: string; title: string }[];
  /** The last 90 days of each post's name, from the numbers; undefined when this person does not see the numbers. */
  results?: Record<string, Result>;
  currency: string;
}) {
  const [links, setLinks] = useState(given);
  const [name, setName] = useState("");
  const [place, setPlace] = useState("instagram");
  const [target, setTarget] = useState("store");
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState("");
  const named = linkName(name);

  async function send(body: Record<string, unknown>, done: string): Promise<boolean> {
    setBusy(true);
    try {
      const response = await fetch("/api/store/short-links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; links?: ShortLink[]; error?: string };
      if (answer.ok && answer.links) {
        setLinks(answer.links);
        toast(done);
        return true;
      }
      toast(REASONS[answer.error ?? ""] ?? "That did not save. Try again.");
    } catch {
      toast("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
    return false;
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Link copied.");
    } catch {
      toast("Select the link and copy it.");
    }
  }

  const where = (t: LinkTarget) =>
    t.kind === "store"
      ? "Your store"
      : t.kind === "product"
        ? products.find((p) => p.id === t.id)?.title ?? "A product no longer listed"
        : `a ready cart of ${t.ids.length} products${t.code ? ` with the code ${t.code}` : ""}`;

  return (
    <section className="mt-6" aria-labelledby="short-links-title" data-short-links>
      <h3 id="short-links-title" className="text-sm font-bold text-ink">Short links for posts</h3>
      <p className="mt-1 text-xs text-ink-soft">
        A short address for each post, video, talk or flyer, with its own QR code. It opens your store or a product already
        tagged with where you posted it, so each link has its own line of visits, sales and revenue, and you can change where
        it goes here without editing the post. A change reaches everyone within five minutes.
      </p>
      <form
        className="mt-3 grid gap-2 sm:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (await send({ action: "add", name, place, target: targetFrom(target) }, "Short link made.")) setName("");
        }}
      >
        <label className="min-w-0 sm:col-span-2">
          <span className="field-label">Name of the post</span>
          <input className="field mt-1 py-2" required maxLength={MAX_NAME + 10} value={name} onChange={(e) => setName(e.target.value)} placeholder="october-reel" />
        </label>
        {name && named !== name ? <p className="text-xs text-ink-soft sm:col-span-2">{named ? `Counted as “${named}”.` : "Use letters or numbers."}</p> : null}
        <label>
          <span className="field-label">Where you post it</span>
          <select className="field mt-1 w-full py-2" value={place} onChange={(e) => setPlace(e.target.value)}>
            {POST_PLACES.map((p) => (
              <option key={p.place} value={p.place}>{p.label}</option>
            ))}
            <option value="other">Somewhere else</option>
          </select>
        </label>
        <label>
          <span className="field-label">Where it goes</span>
          <select className="field mt-1 w-full py-2" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="store">Your store</option>
            {products.map((p) => (
              <option key={p.id} value={`product:${p.id}`}>{p.title}</option>
            ))}
          </select>
        </label>
        <div className="sm:col-span-2">
          <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !named || links.length >= MAX_LINKS}>
            Make a short link
          </button>
        </div>
      </form>
      {links.length ? (
        <ul className="mt-3 divide-y divide-line rounded-[12px] bg-white ring-1 ring-line">
          {links.map((link) => {
            const url = shortUrl(link.code);
            const result = results?.[link.name];
            return (
              <li key={link.code} className="px-3 py-3" data-short-link={link.code}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="min-w-0 text-sm">
                    <span className="font-semibold text-ink [overflow-wrap:anywhere]">{link.name}</span>
                    <span className="ml-2 text-ink-soft">{`${placeName(link.place)} · to ${where(link.target)}`}</span>
                  </p>
                  {results ? (
                    <p className="text-xs tabular-nums text-ink-soft">
                      {result ? `Last 90 days: ${result.visits.toLocaleString("en-US")} ${result.visits === 1 ? "visit" : "visits"} · ${result.sales} ${result.sales === 1 ? "sale" : "sales"} · ${formatMoney(result.cents, currency)}` : "Last 90 days: no visits yet"}
                    </p>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input aria-label={`Short link for ${link.name}`} className="field min-w-0 flex-1 py-2" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy(url)}>
                    <Icon name="copy" size={15} />
                    Copy
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm ring-1 ring-line" aria-expanded={qr === link.code} onClick={() => setQr(qr === link.code ? "" : link.code)}>
                    QR code
                  </button>
                </div>
                {qr === link.code ? <LinkQr url={url} name={link.name} /> : null}
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="min-w-0">
                    <span className="field-label">Goes to</span>
                    <select
                      className="field mt-1 py-2"
                      value={targetValue(link.target)}
                      disabled={busy}
                      onChange={(e) => void send({ action: "target", code: link.code, target: targetFrom(e.target.value) }, "Changed. The post now opens the new page.")}
                    >
                      <option value="store">Your store</option>
                      {products.map((p) => (
                        <option key={p.id} value={`product:${p.id}`}>{p.title}</option>
                      ))}
                      {link.target.kind === "product" && !products.some((p) => p.id === (link.target as { id: string }).id) ? <option value={targetValue(link.target)}>A product no longer listed</option> : null}
                      {link.target.kind === "cart" ? <option value={targetValue(link.target)}>{`A ready cart of ${link.target.ids.length} products`}</option> : null}
                    </select>
                  </label>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void send({ action: "remove", code: link.code }, "Ended. The link now says so.")} aria-label={`End the link for ${link.name}`}>
                    End link
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
