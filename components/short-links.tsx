"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { POST_PLACES, qrFileName, qrSvg } from "@/lib/share-links";
import { type LinkTarget, type LinkThen, MAX_LINKS, MAX_NAME, type ShortLink, dateCanceledBy, dateFormFits, datesCame, linkName, seenAt, shortUrl, targetNow } from "@/lib/short-link-rules";
import { useOwnZone } from "@/components/local-clock";
import { formatMoney } from "@/lib/money";

type Result = { visits: number; sales: number; cents: number };

const REASONS: Record<string, string> = {
  same: "The link already goes there. Choose another page for after the date.",
  when: "Choose a date and time at least ten minutes from now and at most two years away.",
  changed: "This link changed since this page showed it, or its date has passed. It is shown here as it is now. Check it, then try again.",
  stale: "This link changed since this page showed it, or its date has passed. Reload the page to see it as it is now, then try again.",
  gone: "That link is no longer in your store. Reload the page to see your links.",
  ended: "That link is no longer in your store, so the change was not saved. Your links are shown here as they are now.",

  name: "Give the post a name, like october-reel.",
  taken: "Another link already has that name. Each post's link needs its own, so its results are its own.",
  target: "Choose where the link goes.",
  network: "That did not save. Check your connection and try again.",
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

/** The server's time on this browser's clock, `skew` being how far the server is ahead. Out of render: read only in handlers and timers. */
const serverNow = (skew: number) => Date.now() + skew;
/** How far the server's clock, read in an answer, is ahead of this browser's. */
const skewFrom = (server: number) => server - Date.now();

/** "June 1, 2027 at 9:00 AM": on the creator's own clock once the page runs, in UTC (and said so) before. */
function WhenWords({ ms }: { ms: number }) {
  const zone = useOwnZone();
  const words = new Date(ms).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short", timeZone: zone || "UTC" });
  return <time dateTime={new Date(ms).toISOString()}>{zone ? words : `${words} UTC`}</time>;
}

/**
 * 510 [CK2] unit 1: the date a link changes where it goes, and the page it
 * opens from then. The date is typed on the creator's own clock and sent as a
 * moment; the server checks it is ten minutes to two years away. A refusal is
 * said here, beside the fields, focused, with the field it is about marked,
 * never only in a toast that goes away (3.3.1, 2.2.3).
 */
function ChangeOnDate({
  link,
  options,
  busy,
  onSave,
  onCancel,
}: {
  link: ShortLink;
  /** The pages it may change to: never the one it opens now. */
  options: { value: string; label: string }[];
  busy: boolean;
  /** Null when saved; otherwise why not, a key of REASONS. */
  onSave: (then: LinkThen) => Promise<string | null>;
  onCancel: () => void;
}) {
  const id = useId();
  const zone = useOwnZone();
  const [when, setWhen] = useState("");
  const [to, setTo] = useState(options[0]?.value ?? "");
  const [problem, setProblem] = useState("");
  /** Which reason the problem is: "when" marks the date, "same" or "target" the page. */
  const [problemOn, setProblemOn] = useState("");
  const [tries, setTries] = useState(0);
  const problemRef = useRef<HTMLParagraphElement>(null);
  // Each refusal, even the same one again, is moved to so it is read at once.
  useEffect(() => {
    if (problem) problemRef.current?.focus();
  }, [problem, tries]);
  const refuse = (reason: string) => {
    setProblem(REASONS[reason] ?? "That did not save. Try again.");
    setProblemOn(reason);
    setTries((n) => n + 1);
  };
  if (!options.length) {
    return (
      <p className="mt-2 text-xs text-ink-soft">
        This link opens your store, so it can only change to a product. Add a product to your store first.
      </p>
    );
  }
  return (
    <form
      className="mt-2 grid gap-2 rounded-[10px] p-3 ring-1 ring-line sm:grid-cols-2"
      aria-labelledby={`${id}-title`}
      onSubmit={async (event) => {
        event.preventDefault();
        const at = when ? new Date(when).getTime() : NaN;
        if (!Number.isFinite(at)) {
          refuse("when");
          return;
        }
        const target = targetFrom(to);
        if (target.kind === "cart") return;
        const refused = await onSave({ at, target });
        if (refused === null) onCancel();
        else refuse(refused);
      }}
    >
      <p id={`${id}-title`} className="text-sm font-semibold text-ink sm:col-span-2">{`Change where “${link.name}” goes on a date`}</p>
      <label className="min-w-0">
        <span className="field-label">Date and time</span>
        <input
          type="datetime-local"
          className="field mt-1 w-full py-2"
          required
          value={when}
          aria-describedby={`${id}-help${problemOn === "when" ? ` ${id}-problem` : ""}`}
          aria-invalid={problemOn === "when" || undefined}
          onChange={(e) => {
            setWhen(e.target.value);
            if (problemOn === "when") setProblemOn("");
          }}
        />
      </label>
      <label className="min-w-0">
        <span className="field-label">Then it goes to</span>
        <select
          className="field mt-1 w-full py-2"
          value={to}
          aria-describedby={problemOn === "same" || problemOn === "target" ? `${id}-problem` : undefined}
          aria-invalid={problemOn === "same" || problemOn === "target" || undefined}
          onChange={(e) => {
            setTo(e.target.value);
            if (problemOn === "same" || problemOn === "target") setProblemOn("");
          }}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <p id={`${id}-help`} className="text-xs text-ink-soft sm:col-span-2">
        {`On your own clock${zone ? ` (${zone})` : ""}. At least ten minutes from now and at most two years away. Until then the link opens the page it opens now. The visits and sales stay on this link's line. You can cancel the change at any time before it happens.`}
      </p>
      {problem ? (
        // Moved to when it appears, so it is read once; an alert role as well would have it read twice.
        <p id={`${id}-problem`} ref={problemRef} tabIndex={-1} className="text-xs font-semibold text-ink sm:col-span-2">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" className="btn btn-secondary btn-sm" disabled={busy}>
          Save the change
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Close
        </button>
      </div>
    </form>
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
  now: serverStart,
}: {
  links: ShortLink[];
  /** The server's clock when the page was made, so the panel reads each date as the server does from the start. */
  now?: number;
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
  const [dating, setDating] = useState("");
  /**
   * The moment the panel reads each link's date against, on the server's clock
   * (`skew`, from each answer's `now`): set when drawn, after each change, at
   * the next date, and when the tab comes back.
   */
  // The page's first drawing, on the server and in the browser alike, reads the server's moment; the skew is this browser's own.
  const [startSkew] = useState(() => (typeof serverStart === "number" ? skewFrom(serverStart) : 0));
  const skew = useRef(startSkew);
  const [now, setNow] = useState(() => serverStart ?? Date.now());
  const clock = () => serverNow(skew.current);
  const where = (t: LinkTarget) =>
    t.kind === "store"
      ? "Your store"
      : t.kind === "product"
        ? products.find((p) => p.id === t.id)?.title ?? "A product no longer listed"
        : `a ready cart of ${t.ids.length} products${t.code ? ` with the code ${t.code}` : ""}`;
  /** The link whose date control takes the focus back once its form closes. */
  const focusDate = useRef("");
  /** What a date that came while the panel was open did, said once in a polite live region. */
  const [said, setSaid] = useState("");
  const sayTimer = useRef(0);
  /** Empties the live region first, so the same words said again are read again. */
  const say = (text: string) => {
    setSaid("");
    window.clearTimeout(sayTimer.current);
    sayTimer.current = window.setTimeout(() => setSaid(text), 100);
  };
  useEffect(() => () => window.clearTimeout(sayTimer.current), []);
  const shown = useRef({ links, now });
  useEffect(() => {
    shown.current = { links, now };
  });
  /**
   * Moves the panel's clock on, on a tick (`fresh` the links shown) and when an
   * answer comes (`fresh` the links it brings). A date passed meanwhile, as the
   * panel showed it, is said in the live region when `fresh` still has it come,
   * and when the focus was on that link's "Cancel the change", which the date
   * replaces with "Change on a date", it moves to that one (same id), never to
   * the page's start.
   */
  const advance = (fresh: ShortLink[]) => {
    const at = serverNow(skew.current);
    const came = datesCame(shown.current.links, fresh, shown.current.now, at);
    if (came.length) {
      const active = document.activeElement;
      const held = came.find((l) => active instanceof HTMLElement && active.id === `short-link-date-${l.code}`);
      if (held) focusDate.current = held.code;
      say(came.map((l) => `The date for ${l.name} has come: it now goes to ${l.then ? where(l.then.target) : where(l.target)}.`).join(" "));
    }
    setNow(at);
  };
  const tick = () => advance(shown.current.links);
  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  });
  const nextDate = links.reduce((soonest, l) => (l.then && l.then.at > now && l.then.at < soonest ? l.then.at : soonest), Infinity);
  useEffect(() => {
    if (!Number.isFinite(nextDate)) return;
    // A timer runs at most about 24 days at once; a later date is reached by the next one.
    const timer = window.setTimeout(() => tickRef.current(), Math.min(nextDate - now + 50, 2_000_000_000));
    return () => window.clearTimeout(timer);
  }, [nextDate, now]);
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "visible") tickRef.current();
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, []);
  /** What this panel shows of a link, sent with each change so the server applies it only to that (lib/short-link-rules.ts, Seen). */
  const seenOf = (link: ShortLink) => seenAt(link, now);
  /** A refusal of "Goes to" or "Cancel the change", said beside its link and moved to. */
  const [rowProblem, setRowProblem] = useState<{ code: string; text: string } | null>(null);
  const rowRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (rowProblem) rowRef.current?.focus();
  }, [rowProblem]);
  /**
   * A refusal for a link no longer in the answer's list, so no longer shown:
   * said in the panel's own place, which stays until the next change, and
   * moved to (each time anew, as a new object).
   */
  const [status, setStatus] = useState<{ text: string } | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (status) statusRef.current?.focus();
  }, [status]);
  /** The links a "changed" refusal brought, as they are now; null after any other answer. */
  const refused = useRef<ShortLink[] | null>(null);
  /** Says a change's answer for one link: beside it, or in the panel's own place when the links brought no longer have it. */
  const refuseRow = (code: string, refusal: string | null) => {
    if (refusal === null) {
      setRowProblem(null);
      return;
    }
    if (refusal === "changed" && refused.current && !refused.current.some((l) => l.code === code)) {
      setRowProblem(null);
      setStatus({ text: REASONS.ended });
      return;
    }
    setRowProblem({ code, text: REASONS[refusal] ?? "That did not save. Try again." });
  };
  useEffect(() => {
    if (!focusDate.current) return;
    document.getElementById(`short-link-date-${focusDate.current}`)?.focus();
    focusDate.current = "";
  });
  const named = linkName(name);

  /**
   * Sends a change. Null when it saved, said by `done` from the links in the
   * answer, never from what the panel had; otherwise why not (a key of
   * REASONS), said in a toast unless `quiet`, where the caller says it beside
   * its fields. A "changed" answer brings the links as they are: shown at once.
   */
  async function send(body: Record<string, unknown>, done: string | ((links: ShortLink[]) => string), { quiet = false } = {}): Promise<string | null> {
    setBusy(true);
    let reason = "network";
    refused.current = null;
    try {
      const response = await fetch("/api/store/short-links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; links?: ShortLink[]; error?: string; now?: unknown };
      if (typeof answer.now === "number" && Number.isFinite(answer.now)) skew.current = skewFrom(answer.now);
      if (answer.ok && answer.links) {
        setLinks(answer.links);
        advance(answer.links);
        setRowProblem(null);
        setStatus(null);
        toast(typeof done === "string" ? done : done(answer.links));
        return null;
      }
      if (answer.error === "changed" && answer.links) {
        setLinks(answer.links);
        advance(answer.links);
        refused.current = answer.links;
      }
      // "changed" with no links (they could not be read): never said as shown here.
      reason = answer.error === "changed" && !answer.links ? "stale" : answer.error ?? "";
    } catch {
      reason = "network";
    } finally {
      setBusy(false);
    }
    if (!quiet) toast(REASONS[reason] ?? "That did not save. Try again.");
    return reason;
  }

  /** Where a link in an answer goes at this moment, said as a page. */
  const opensIn = (list: ShortLink[], code: string) => {
    const found = list.find((l) => l.code === code);
    return found ? where(targetNow(found, clock())) : "the page it opens";
  };

  const closeDate = (code: string) => {
    focusDate.current = code;
    setDating("");
  };

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Link copied.");
    } catch {
      toast("Select the link and copy it.");
    }
  }

  return (
    <section className="mt-6" aria-labelledby="short-links-title" data-short-links>
      <p className="sr-only" aria-live="polite">{said}</p>
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
          if ((await send({ action: "add", name, place, target: targetFrom(target) }, "Short link made.")) === null) setName("");
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
      {status ? (
        // Moved to when it appears, so it is read once and stays until the next change; the links below are already as they are now.
        <p ref={statusRef} tabIndex={-1} className="mt-3 text-xs font-semibold text-ink">
          {status.text}
        </p>
      ) : null}
      {links.length ? (
        <ul className="mt-3 divide-y divide-line rounded-[12px] bg-white ring-1 ring-line">
          {links.map((link) => {
            const url = shortUrl(link.code);
            const result = results?.[link.name];
            const opens = targetNow(link, now);
            const passed = Boolean(link.then && now >= link.then.at);
            return (
              <li key={link.code} className="px-3 py-3" data-short-link={link.code}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="min-w-0 text-sm">
                    <span className="font-semibold text-ink [overflow-wrap:anywhere]">{link.name}</span>
                    <span className="ml-2 text-ink-soft">{`${placeName(link.place)} · to ${where(targetNow(link, now))}`}</span>
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
                      value={targetValue(targetNow(link, now))}
                      disabled={busy}
                      aria-describedby={rowProblem?.code === link.code ? `short-link-problem-${link.code}` : undefined}
                      onChange={async (e) => {
                        const shownNow = now;
                        const refusal = await send(
                          { action: "target", code: link.code, target: targetFrom(e.target.value), seen: seenOf(link) },
                          (links) =>
                            // The page chosen was the one the date would send it to, so the date was taken back: said, not left to be noticed.
                            dateCanceledBy(link, links.find((l) => l.code === link.code), shownNow)
                              ? `Changed. The post now opens ${opensIn(links, link.code)}. The change you set for a date is canceled, as the link already goes there.`
                              : `Changed. The post now opens ${opensIn(links, link.code)}.`,
                          { quiet: true },
                        );
                        refuseRow(link.code, refusal);
                      }}
                    >
                      <option value="store">Your store</option>
                      {products.map((p) => (
                        <option key={p.id} value={`product:${p.id}`}>{p.title}</option>
                      ))}
                      {opens.kind === "product" && !products.some((p) => p.id === (opens as { id: string }).id) ? <option value={targetValue(opens)}>A product no longer listed</option> : null}
                      {/* The link's own ready cart stays a choice, after its date too, to go back to it. */}
                      {link.target.kind === "cart" ? <option value={targetValue(link.target)}>{`A ready cart of ${link.target.ids.length} products`}</option> : null}
                    </select>
                  </label>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void send({ action: "remove", code: link.code }, "Ended. The link now says so.")} aria-label={`End the link for ${link.name}`}>
                    End link
                  </button>
                </div>
                {rowProblem?.code === link.code ? (
                  // Moved to when it appears, so it is read once and stays until the next change.
                  <p id={`short-link-problem-${link.code}`} ref={rowRef} tabIndex={-1} className="mt-2 text-xs font-semibold text-ink">
                    {rowProblem.text}
                  </p>
                ) : null}
                {link.then && !passed ? (
                  <div className="mt-2 flex flex-wrap items-baseline gap-2">
                    <p className="min-w-0 text-xs text-ink">
                      {"From "}
                      <WhenWords ms={link.then.at} />
                      {`, it goes to ${where(link.then.target)}.`}
                    </p>
                    <button
                      id={`short-link-date-${link.code}`}
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      aria-label={`Cancel the change for ${link.name}`}
                      onClick={async () => {
                        const refusal = await send({ action: "then", code: link.code, then: null, seen: seenOf(link) }, (links) => `Canceled. The link goes to ${opensIn(links, link.code)}.`, { quiet: true });
                        if (refusal === null) focusDate.current = link.code;
                        refuseRow(link.code, refusal);
                      }}
                    >
                      Cancel the change
                    </button>
                  </div>
                ) : (
                  <>
                    {link.then ? (
                      // After the date nothing is left to cancel: "Goes to" above changes the page it opens.
                      <p className="mt-2 text-xs text-ink">
                        {"Since "}
                        <WhenWords ms={link.then.at} />
                        {`, it goes to ${where(link.then.target)} instead of ${where(link.target)}.`}
                      </p>
                    ) : null}
                    <button
                      id={`short-link-date-${link.code}`}
                      type="button"
                      className="btn btn-ghost btn-sm mt-2 ring-1 ring-line"
                      aria-expanded={dating === link.code}
                      aria-label={`Change on a date where the link for ${link.name} goes`}
                      onClick={() => setDating(dating === link.code ? "" : link.code)}
                    >
                      Change on a date
                    </button>
                  </>
                )}
                {dating === link.code && (!link.then || passed) ? (
                  <ChangeOnDate
                    link={link}
                    busy={busy}
                    options={[{ value: "store", label: "Your store" }, ...products.map((p) => ({ value: `product:${p.id}`, label: p.title }))].filter((o) => o.value !== targetValue(opens))}
                    onSave={async (then) => {
                      const refusal = await send(
                        { action: "then", code: link.code, then, seen: seenOf(link) },
                        (links) => {
                          const saved = links.find((l) => l.code === link.code)?.then;
                          return saved ? `Saved. On that date the link starts going to ${where(saved.target)}.` : "Saved.";
                        },
                        { quiet: true },
                      );
                      if (refusal === null) focusDate.current = link.code;
                      if (refusal === "changed") {
                        // The link is now shown as it is. While the page chosen still fits it, the form stays with what was typed
                        // and says why beside its fields (3.3.7); otherwise it closes and the reason is said beside the link,
                        // or, when the link is gone, in the panel's own place, focused, never only in a toast that goes away.
                        const fresh = refused.current?.find((l) => l.code === link.code);
                        if (!dateFormFits(fresh, then.target, clock())) {
                          setDating("");
                          refuseRow(link.code, "changed");
                        }
                      }
                      return refusal;
                    }}
                    onCancel={() => closeDate(link.code)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
