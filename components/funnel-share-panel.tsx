"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { type BundleOutline, type ImportRoom, type PlanLine, type ReceiverProduct, planImport } from "@/lib/funnel-bundle";
import { DEFAULT_SHARE_DAYS, SHARE_DAYS, type ShareLimits, bytesWords, codeFrom } from "@/lib/funnel-share-rules";
import { MAX_FUNNEL_NAME } from "@/lib/page-funnel";
import { FunnelStarterGallery } from "@/components/funnel-starter-gallery";
import type { StarterCard, StarterGoal } from "@/lib/funnel-starter-catalog";

export type ShareRow = { id: string; name: string; funnelId: string; createdAt: number; expiresAt: number; hint: string };

const MESSAGES: Record<string, string> = {
  code: "That does not look like a share code. It starts with mmf_.",
  code_gone: "That link has been revoked, has run out, or was never made. Ask for a new one.",
  share_busy: "That link has been used as often as it can be this month. Ask the creator for the file instead.",
  shares_month: "Your store has made as many share links as its figure allows for now. More can be made when the figure opens again.",
  previews_month: "Your store has looked at as many funnels as its figure allows for now. More can be looked at when the figure opens again.",
  exports_month: "Your store has downloaded as many funnel files as its figure allows for now. More can be downloaded when the figure opens again.",
  busy: "Too many previews in the last hour. Try again in a little while.",
  shares_full: "Your store holds all the share links it can keep. Revoke one to make another.",
  imports_full: "Your store has brought in as many funnels as its figure allows for now. More can come in when the figure opens again.",
  too_big: "This funnel is larger than your store can put in one file.",
  days: "Choose how long the link should work.",
  unknown: "That funnel is gone. Reload the page.",
  plan: "Something in the preview stops it. Review the list below.",
  pages_full: "Your store has no room for its pages. Remove a page under Pages first.",
  forms_full: "Your store has no room for its forms. Review Forms first.",
  full: "Your store has all the funnels it can hold. Remove one first.",
  forbidden: "Your role cannot change the store's pages and products, which this needs.",
  setup_incomplete: "We could not confirm it finished. Some pages, forms or the funnel may already exist: review them before trying again.",
  bundle_format: "This is not a Marktmorgen funnel file.",
  bundle_newer: "This file was made by a newer version of Marktmorgen. Reload the page and try again.",
  bundle_too_big: "This file is larger than your store can bring in.",
  bundle_unsafe: "This file contains something that looks like code, so it is not accepted.",
  bundle_shape: "This file has parts the funnel format does not have, so it is not accepted.",
  bundle_steps: "The file's steps do not match its pages and products.",
  bundle_pages: "One of the file's pages is not one a store can have.",
  bundle_blocks: "One of the file's blocks would not be kept as it is written.",
  bundle_kind: "The file has a block a store's own page cannot hold.",
  bundle_pictures: "The file names pictures, which are never shared between stores.",
  bundle_forms: "One of the file's forms would not be kept as it is written.",
  bundle_forms_sensitive: "One of the file's forms asks for a password, a card number, a card's security code or an identity number, which a form never may. Nothing was imported.",
  bundle_products: "The file's products do not match where it uses them.",
  server_error: "We could not confirm the result. Reload and review your funnels before trying again.",
  funnel_unread: "Part of this funnel could not be read just now, so nothing was made from it. Reload, then try again.",
  funnel_unread_counted: "Part of this funnel could not be read just now, so nothing was made from it. This try still counts toward this month's figure. Reload, then try again.",
  owner_only: "Only the account's owner can copy a funnel into another of its stores.",
  not_yours: "That store is not another store of this account. Reload the page.",
  target_used: "That store has used its studio requests for this billing month.",
  ...STUDIO_MESSAGES,
};

const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

type Preview = {
  source: { code: string } | { bundle: unknown } | { starter: string } | { funnel: string; to: string };
  from: string;
  /** For a copy into another store of the account: which one, and what the copy leaves out. */
  to?: { sid: string; name: string };
  left?: string[];
  outline: BundleOutline;
  products: ReceiverProduct[];
  room: ImportRoom;
  sizeStop: PlanLine | null;
};

async function post(body: Record<string, unknown>): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch("/api/store/funnel-share", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = ((await response.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  return { status: response.status, data };
}

/**
 * Copying, sharing and bringing in funnels (lib/funnel-bundle.ts): a copy
 * inside the store, a share link or a file for another Marktmorgen store,
 * and a preview that maps the funnel's products to this store's before
 * anything is made.
 */
export function FunnelSharePanel({
  funnels,
  shares,
  limits,
  starters,
  sid,
  otherStores = [],
  starterGoal = "all",
}: {
  /** The store this page was drawn for, so a download opens the same store's file. */
  sid: string;
  funnels: { id: string; name: string }[];
  /** Null when the store's links could not be read. */
  shares: ShareRow[] | null;
  limits: ShareLimits;
  starters: StarterCard[];
  starterGoal?: StarterGoal | "all";
  /** The account's other stores, for the owner: where a funnel can be copied to. */
  otherStores?: { sid: string; name: string }[];
}) {
  const router = useRouter();
  const [picked, setPicked] = useState(funnels[0]?.id ?? "");
  const [days, setDays] = useState<number>(DEFAULT_SHARE_DAYS);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ code: string; link: string; left: string[] } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [result, setResult] = useState<{ lines: PlanLine[]; left: string[]; to?: string } | null>(null);
  const [copyTo, setCopyTo] = useState(otherStores[0]?.sid ?? "");
  const fileInput = useRef<HTMLInputElement>(null);
  const chosen = funnels.some((f) => f.id === picked) ? picked : funnels[0]?.id ?? "";

  async function run<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    if (busy) return undefined;
    setBusy(label);
    setError(null);
    try {
      return await work();
    } catch {
      setError(MESSAGES.server_error);
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function openPreview(source: Preview["source"]) {
    await run("preview", async () => {
      const { data } = await post("to" in source ? { action: "copy-preview", ...source } : { action: "preview", ...source });
      if (data.ok !== true) {
        setError(MESSAGES[String(data.error)] ?? MESSAGES.server_error);
        return;
      }
      const outline = data.outline as BundleOutline;
      const plan = data.plan as { lines: PlanLine[] };
      setPreview({
        source,
        from: String(data.from ?? ""),
        outline,
        products: data.products as ReceiverProduct[],
        room: data.room as ImportRoom,
        sizeStop: plan.lines.find((line) => line.level === "stop" && line.text.startsWith("It weighs")) ?? null,
        ...(data.to && typeof data.to === "object" ? { to: data.to as { sid: string; name: string }, left: (data.left as string[]) ?? [] } : {}),
      });
      setMapping({});
      setName(outline.name);
      setResult(null);
    });
  }

  // A link opened from someone else: /studio/funnels#import=<code>, read once after the first draw.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const starterId = new URLSearchParams(window.location.hash.slice(1)).get("starter");
      if (starterId && starters.some(item => item.id === starterId)) {
        history.replaceState(null, "", window.location.pathname + window.location.search);
        void openPreview({ starter: starterId });
        return;
      }
      const found = codeFrom(window.location.hash);
      if (!found) return;
      setCode(found);
      history.replaceState(null, "", window.location.pathname + window.location.search);
      void openPreview({ code: found });
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const plan = preview ? planImport(preview.outline, preview.products, preview.room, mapping) : null;
  const lines = plan ? [...(preview?.sizeStop ? [preview.sizeStop] : []), ...plan.lines] : [];
  const canImport = Boolean(plan?.ok && !preview?.sizeStop);

  async function share() {
    await run("share", async () => {
      const { data } = await post({ action: "share", funnel: chosen, days });
      if (data.ok !== true) {
        setError(MESSAGES[String(data.error)] ?? MESSAGES.server_error);
        return;
      }
      setMade({ code: String(data.code), link: String(data.link), left: (data.left as string[]) ?? [] });
      router.refresh();
    });
  }

  async function clone() {
    await run("clone", async () => {
      const { data } = await post({ action: "clone", funnel: chosen });
      if (data.ok !== true) {
        setError(MESSAGES[String(data.error)] ?? MESSAGES.server_error);
        return;
      }
      toast("Copy made, off and with its pages kept back.");
      setResult({ lines: (data.lines as PlanLine[]) ?? [], left: (data.left as string[]) ?? [] });
      router.refresh();
    });
  }

  async function revoke(id: string) {
    await run("revoke", async () => {
      const { data } = await post({ action: "revoke", id });
      if (data.ok !== true) {
        setError(MESSAGES[String(data.error)] ?? MESSAGES.server_error);
        return;
      }
      toast("Link revoked. It stopped working.");
      setRevoking(null);
      router.refresh();
    });
  }

  async function bringIn() {
    if (!preview || !canImport) return;
    await run("import", async () => {
      const copying = "to" in preview.source;
      const { data } = await post({ action: copying ? "copy" : "import", ...preview.source, products: plan?.mapped ?? {}, name });
      if (data.ok !== true) {
        setError(MESSAGES[String(data.error)] ?? MESSAGES.server_error);
        return;
      }
      toast(copying ? `Copied into ${preview.to?.name ?? "your other store"} as a draft.` : "Funnel brought in as a draft.");
      setResult({ lines: (data.lines as PlanLine[]) ?? [], left: copying ? ((data.left as string[]) ?? []) : [], ...(copying ? { to: preview.to?.name ?? "your other store" } : {}) });
      setPreview(null);
      setCode("");
      router.refresh();
    });
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > limits.bundleBytes) {
      setError(`This file is ${bytesWords(file.size)}; your store can bring in funnels up to ${bytesWords(limits.bundleBytes)}.`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setError(MESSAGES.bundle_format);
      return;
    }
    await openPreview({ bundle: parsed });
  }

  const copy = async (value: string, done: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(done);
    } catch {
      toast("Select it above and copy it.");
    }
  };

  return (
    <section aria-labelledby="funnel-share-title" className="card min-w-0 p-5 sm:p-8">
      <h2 id="funnel-share-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Copy, share and bring in funnels</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-soft">
        {`Make a copy of a funnel here, or share it with another Marktmorgen creator by link or file. They see what it holds before bringing it in, choose their own products for its steps, and get it as a draft. Only the words and the shape go: never your pictures, files, buyers, contacts, answers, reviews, prices or numbers. Your plan: ${limits.shares} share links at once, funnels up to ${bytesWords(limits.bundleBytes)}, ${limits.importsPerMonth} funnels brought in and ${limits.sharesPerMonth} share links made a month.`}
      </p>

      {error ? <p className="notice notice-error mt-4" role="alert">{error}</p> : null}

      <div className="mt-6 rounded-2xl bg-paper p-4 ring-1 ring-line sm:p-5">
        <p className="font-semibold text-ink">Your funnels</p>
        {funnels.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">Make a funnel above, or bring one in below, and you can copy and share it here.</p>
        ) : (
          <>
            <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              <label className="block" htmlFor="fs-funnel">
                <span className="field-label">Funnel</span>
                <select id="fs-funnel" className="field" value={chosen} onChange={(e) => setPicked(e.target.value)}>
                  {funnels.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </label>
              <label className="block" htmlFor="fs-days">
                <span className="field-label">A share link works for</span>
                <select id="fs-days" className="field" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  {SHARE_DAYS.map((d) => (
                    <option key={d} value={d}>{d === 365 ? "1 year" : `${d} days`}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="btn btn-secondary" disabled={busy !== null} aria-busy={busy === "clone"} onClick={() => void clone()}>
                <Icon name="copy" size={17} />
                {busy === "clone" ? "Copying…" : "Make a copy here"}
              </button>
              <button type="button" className="btn btn-secondary" disabled={busy !== null || (shares !== null && shares.length >= limits.shares)} aria-busy={busy === "share"} onClick={() => void share()}>
                <Icon name="link" size={17} />
                {busy === "share" ? "Making the link…" : "Make a share link"}
              </button>
              <a className="btn btn-ghost" href={`/api/store/funnel-share?export=${encodeURIComponent(chosen)}&store=${encodeURIComponent(sid)}`} download>
                <Icon name="download" size={17} />
                Download as a file
              </a>
            </div>
            <p className="mt-2 text-xs text-ink-soft">
              A copy keeps your words, videos and products and leaves the pictures on the original pages. A link or file is a snapshot of the funnel as it is now; your later changes are not in it.
            </p>
            {otherStores.length ? (
              <form
                className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (chosen && copyTo) void openPreview({ funnel: chosen, to: copyTo });
                }}
              >
                <label className="block min-w-0 flex-1" htmlFor="fs-copy-to">
                  <span className="field-label">Copy it into another of your stores</span>
                  <select id="fs-copy-to" className="field" value={copyTo} onChange={(e) => setCopyTo(e.target.value)}>
                    {otherStores.map((s) => (
                      <option key={s.sid} value={s.sid}>{s.name}</option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="btn btn-secondary" disabled={busy !== null || !copyTo} aria-busy={busy === "preview"}>
                  Preview the copy there
                </button>
                <p className="basis-full text-xs text-ink-soft">
                  It keeps your words, videos, about text, deadlines and what was said about you elsewhere, since both stores are yours. Pictures stay on the original pages. You choose that store&apos;s products for its steps, and it arrives there as a draft.
                </p>
              </form>
            ) : null}
          </>
        )}

        {made ? (
          <div className="notice notice-warn mt-4" role="status">
            <p className="font-semibold text-ink">Copy the link now: it is shown only this once</p>
            <p className="mt-2 break-all font-mono text-sm text-ink">{made.link}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(made.link, "Link copied.")}>
                <Icon name="copy" size={16} />
                Copy the link
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(made.code, "Code copied.")}>
                <Icon name="copy" size={16} />
                Copy the code only
              </button>
            </div>
            <p className="mt-2 text-xs text-ink-soft">Anyone with a Marktmorgen store and this link can preview and bring in a copy until you revoke it or it runs out. Only its fingerprint is kept, so it cannot be shown again.</p>
            {made.left.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-soft">
                {made.left.map((line) => <li key={line}>{line}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}

        <p className="field-label mt-5">{shares === null ? "Share links" : `Share links (${shares.length} of ${limits.shares})`}</p>
        {shares === null ? (
          <p className="text-sm text-ink-soft">Your share links could not be read just now. Reload to see and revoke them.</p>
        ) : shares.length === 0 ? (
          <p className="text-sm text-ink-soft">None. A link you make shows here until it runs out or you revoke it.</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {shares.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] bg-white px-3 py-2 text-sm ring-1 ring-line">
                <span className="min-w-0">
                  <span className="font-semibold text-ink">{s.name}</span>
                  <span className="ml-2 text-ink-mute">{`…${s.hint} · made ${day(s.createdAt)} · works until ${day(s.expiresAt)}`}</span>
                </span>
                {revoking === s.id ? (
                  <span className="flex items-center gap-2">
                    <button type="button" className="btn btn-danger btn-sm" disabled={busy !== null} onClick={() => void revoke(s.id)}>Yes, revoke</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRevoking(null)}>Keep it</button>
                  </span>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => setRevoking(s.id)}>Revoke</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-6 rounded-2xl bg-paper p-4 ring-1 ring-line sm:p-5">
        <p className="font-semibold text-ink">Bring a funnel in</p>
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const found = codeFrom(code);
            if (!found) {
              setError(MESSAGES.code);
              return;
            }
            void openPreview({ code: found });
          }}
        >
          <label className="block min-w-0 flex-1" htmlFor="fs-code">
            <span className="field-label">A share link or code</span>
            <input id="fs-code" type="text" className="field" value={code} onChange={(e) => setCode(e.target.value)} placeholder="mmf_…" autoComplete="off" spellCheck={false} />
          </label>
          <button type="submit" className="btn btn-secondary" disabled={busy !== null || !code.trim()} aria-busy={busy === "preview"}>
            Preview
          </button>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-ink-soft">
          <span>Or a funnel file:</span>
          <input ref={fileInput} type="file" accept="application/json,.json" className="sr-only" id="fs-file" onChange={(e) => { void readFile(e.target.files?.[0]); e.target.value = ""; }} />
          <label htmlFor="fs-file" className="btn btn-ghost btn-sm cursor-pointer">
            <Icon name="file" size={16} />
            Choose a file
          </label>
        </div>

        {starters.length ? (
          <FunnelStarterGallery key={starterGoal} initialGoal={starterGoal} starters={starters} busy={busy !== null} onChoose={(id) => void openPreview({ starter: id })} />
        ) : null}

        {preview && plan ? (
          <div className="mt-5 rounded-2xl border-2 border-violet-brand/40 bg-white p-4 sm:p-5">
            <p className="font-semibold text-ink">{preview.outline.name}</p>
            <p className="mt-1 text-xs text-ink-mute">
              {`${preview.to ? `From ${preview.from} into ${preview.to.name} · ` : preview.from ? `Shared by ${preview.from} · ` : ""}${preview.outline.steps.length} ${preview.outline.steps.length === 1 ? "step" : "steps"} · ${preview.outline.pages.length} ${preview.outline.pages.length === 1 ? "page" : "pages"} · ${preview.outline.forms.length} ${preview.outline.forms.length === 1 ? "form" : "forms"} · ${bytesWords(preview.outline.bytes)}`}
            </p>
            <ol className="mt-3 space-y-1 text-sm">
              {preview.outline.steps.map((step, i) => {
                const page = step.kind === "page" ? preview.outline.pages.find((p) => p.ref === step.ref) : null;
                return (
                  <li key={`${step.kind}-${step.ref}`} className="rounded-[12px] bg-paper px-3 py-2 ring-1 ring-line">
                    <span className="font-semibold text-ink">{`${i + 1}. ${step.title}`}</span>
                    <span className="ml-2 text-ink-mute">{step.kind === "page" ? `page: ${page?.kinds.join(", ") ?? ""}` : "your product"}</span>
                  </li>
                );
              })}
            </ol>

            {preview.outline.products.length ? (
              <div className="mt-4 space-y-3">
                <p className="field-label">{preview.to ? `${preview.to.name}'s products for it` : "Your products for it"}</p>
                {preview.outline.products.map((slot) => (
                  <label key={slot.ref} className="block" htmlFor={`fs-map-${slot.ref}`}>
                    <span className="text-sm text-ink">{`${slot.label}`}<span className="ml-1 text-ink-mute">{`(${slot.wants === "free" ? "free" : "paid"}${slot.step ? ", a step" : ""})`}</span></span>
                    <select id={`fs-map-${slot.ref}`} className="field mt-1" value={mapping[slot.ref] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [slot.ref]: e.target.value }))}>
                      <option value="">Leave it out</option>
                      {preview.products
                        .filter((p) => !(slot.step && p.call))
                        .map((p) => (
                          <option key={p.id} value={p.id}>{`${p.title}${p.free ? " (free)" : ""}${p.draft ? " (draft)" : ""}`}</option>
                        ))}
                    </select>
                  </label>
                ))}
              </div>
            ) : null}

            <label className="mt-4 block" htmlFor="fs-name">
              <span className="field-label">Name, for you</span>
              <input id="fs-name" type="text" className="field" maxLength={MAX_FUNNEL_NAME} value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            <p className="field-label mt-4">Before it is made</p>
            <ul className="space-y-1.5 text-sm">
              {lines.map((line, i) => (
                <li key={`${i}-${line.text}`} className="flex gap-2">
                  <Icon name={line.level === "ok" ? "check" : line.level === "fix" ? "info" : "alert"} size={16} className={line.level === "stop" ? "mt-0.5 shrink-0 text-danger" : line.level === "fix" ? "mt-0.5 shrink-0 text-violet-deep" : "mt-0.5 shrink-0 text-mint-deep"} />
                  <span className={line.level === "stop" ? "font-semibold text-ink" : "text-ink-soft"}>{line.text}</span>
                </li>
              ))}
              {(preview.left ?? []).map((text) => (
                <li key={`left-${text}`} className="flex gap-2">
                  <Icon name="info" size={16} className="mt-0.5 shrink-0 text-violet-deep" />
                  <span className="text-ink-soft">{text}</span>
                </li>
              ))}
            </ul>

            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" className="btn btn-primary" disabled={busy !== null || !canImport} aria-busy={busy === "import"} onClick={() => void bringIn()}>
                {busy === "import" ? (preview.to ? "Copying…" : "Bringing it in…") : preview.to ? `Copy it into ${preview.to.name} as a draft` : "Bring it in as a draft"}
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => setPreview(null)}>Cancel</button>
            </div>
          </div>
        ) : null}

        {result ? (
          <div className="notice notice-success mt-4" role="status">
            <p className="font-semibold text-ink">{result.to ? `Made in ${result.to} as a draft: open that store to find it, off, with its pages kept back.` : "Made as a draft. It is in the list above, off, with its pages kept back."}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
              {[...result.left, ...result.lines.filter((line) => line.level !== "ok").map((line) => line.text)].map((text) => <li key={text}>{text}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
