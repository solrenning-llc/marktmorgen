"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { DEFAULT_PLACE, MAX_PLACE, buttonColors, embedPlace } from "@/lib/embed-rules";
import { MAX_CAMPAIGN, MAX_EMBED_SITES, type ScriptMode, listedReturn, readEmbedSites } from "@/lib/embed-sites";
import { BUILDERS, MAX_LINK_TEXT, cspLines, loaderHash, scriptCode } from "@/lib/embed-sdk";
import { NewTab } from "@/components/new-tab";

const subscribeToEditorReadiness = () => () => {};
const editorClientReady = () => true;
const editorServerReady = () => false;

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  invalid: "Each line needs to be an https website address, like https://www.example.com.",
  too_many: `A store can list up to ${MAX_EMBED_SITES} sites.`,
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "We could not confirm this website list. Reload this page to check before trying again.",
};

/**
 * The checkout script (lib/embed-sdk.ts): the sites that may open the store's
 * checkout card and sign-up form over their pages, and the code to paste
 * there, with what a site's own security policy needs to let it run.
 *
 * The list is saved; the code is not. It is built here from what is on the
 * screen, and everything in it but the script is in the link, so one script
 * serves every link on a page.
 */
export function CheckoutScriptEditor({
  handle,
  products,
  fill,
  onFill,
  sites: savedSites,
  signup,
}: {
  handle: string;
  products: { id: string; title: string }[];
  fill: string;
  onFill: string;
  sites: string[];
  /** Whether the store takes sign-ups to its list (lib/store-join.ts joinOpen). */
  signup: boolean;
}) {
  const ready = useSyncExternalStore(subscribeToEditorReadiness, editorClientReady, editorServerReady);
  const [sites, setSites] = useState(savedSites);
  const [draft, setDraft] = useState(savedSites.join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [what, setWhat] = useState<string>(products[0]?.id ?? (signup ? "join" : ""));
  const [mode, setMode] = useState<ScriptMode>("overlay");
  const [place, setPlace] = useState("");
  const [campaign, setCampaign] = useState("");
  const [back, setBack] = useState("");
  const [text, setText] = useState("");
  const [hash, setHash] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loaderHash().then(setHash, () => setHash(""));
  }, []);

  const typed = readEmbedSites(draft);
  const changed = typed.ok ? typed.sites.join("\n") !== sites.join("\n") : draft.trim() !== sites.join("\n");

  async function save() {
    if (!ready || saving) return;
    if (!typed.ok) {
      toast(typed.reason === "too_many" ? MESSAGES.too_many : `${MESSAGES.invalid}${typed.line ? ` This one is not: ${typed.line}` : ""}`);
      return;
    }
    const expected = [...typed.sites];
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/store/embed-sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sites: typed.sites }) });
      const raw: unknown = await response.json().catch(() => null);
      const reply = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      const matches = Array.isArray(reply?.sites) && reply.sites.length === expected.length && reply.sites.every((site: unknown, i: number) => site === expected[i]);
      if (response.ok && reply?.ok === true && !("error" in reply) && matches) {
        setSites(expected);
        setDraft(expected.join("\n"));
        toast("Website list saved.");
      } else {
        const problem = reply?.ok !== true && typeof reply?.error === "string" && Object.hasOwn(MESSAGES, reply.error) ? MESSAGES[reply.error] : null;
        setError(problem ?? MESSAGES.server_error);
      }
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setSaving(false);
    }
  }

  const product = products.find((p) => p.id === what) ?? null;
  const forSignup = what === "join";
  const colorsChanged = buttonColors(fill, onFill).changed;
  const backOk = !back.trim() || listedReturn(sites, back.trim()) !== null;
  const code =
    product || forSignup
      ? scriptCode({
          handle,
          productId: product ? product.id : null,
          place: embedPlace(place),
          campaign: campaign.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "").slice(0, MAX_CAMPAIGN),
          back: backOk && back.trim() ? (listedReturn(sites, back.trim()) ?? undefined) : undefined,
          text: text || (product ? `Buy ${product.title}` : "Join my list"),
          mode,
          fill,
          onFill,
        })
      : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast("Copied. Paste it into your website.");
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      toast("Select the code and copy it.");
    }
  }

  return (
    <div aria-busy={saving} className="card min-w-0 p-6 sm:p-8" id="checkout-script">
      <p className="text-lg font-semibold tracking-[-0.02em] text-ink">Checkout on your own website</p>
      <p className="mt-2 text-ink-soft">
        A link on any page of yours opens a product&apos;s card, or your sign-up form, over that page. Your buyer pays on Stripe&apos;s page, on
        your own Stripe account, and your page is told what happened, so it can say thank you. It works on the sites you list here; anywhere
        else the link opens your product&apos;s page instead.
      </p>

      <label className="mt-6 block">
        <span className="flex items-baseline justify-between gap-3">
          <span className="field-label">Your sites</span>
          <span className="text-xs tabular-nums text-ink-mute">{`${typed.ok ? typed.sites.length : "?"}/${MAX_EMBED_SITES}`}</span>
        </span>
        <textarea
          disabled={!ready || saving}
          className="field mt-1 font-mono text-sm"
          rows={3}
          value={draft}
          placeholder={"https://www.example.com\nhttps://blog.example.com"}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <p className="mt-2 text-sm text-ink-soft">
        {`One per line, https only, up to ${MAX_EMBED_SITES}. Each address is one site: www.example.com and example.com are two. Once you list a site, the cards you pasted with the frame code show a plain link anywhere else, too.`}
      </p>
      {!typed.ok ? (
        <p className="mt-2 text-sm font-semibold text-ink">{typed.reason === "too_many" ? MESSAGES.too_many : `${MESSAGES.invalid}${typed.line ? ` This one is not: ${typed.line}` : ""}`}</p>
      ) : null}
      <div className="mt-3">
        <button type="button" className="btn btn-secondary btn-sm" disabled={!ready || saving || !changed || !typed.ok} onClick={() => void save()}>
          {saving ? "Saving…" : "Save sites"}
        </button>
      </div>

      {error ? <p className="notice notice-error mt-3" role="alert">{error}</p> : null}

      {products.length || signup ? (
        <>
          <div className="mt-8 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="min-w-0">
              <span className="field-label">What it opens</span>
              <span className="relative mt-1 block min-w-0">
              <select className="field min-w-0 max-w-full appearance-none overflow-hidden pr-10" value={what} onChange={(event) => setWhat(event.target.value)}>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
                {signup ? <option value="join">Your email list&apos;s sign-up form</option> : null}
              </select>
              <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"><Icon name="chevron-down" size={16} /></span>
            </span>
            </label>
            <label className="min-w-0">
              <span className="flex items-baseline justify-between gap-3">
                <span className="field-label">What the link says</span>
                <span className="text-xs tabular-nums text-ink-mute">{`${text.length}/${MAX_LINK_TEXT}`}</span>
              </span>
              <input className="field mt-1" maxLength={MAX_LINK_TEXT} value={text} placeholder={product ? `Buy ${product.title}` : "Join my list"} onChange={(event) => setText(event.target.value)} />
            </label>
            <label className="min-w-0">
              <span className="flex items-baseline justify-between gap-3">
                <span className="field-label">Where it goes</span>
                <span className="text-xs text-ink-mute">Optional</span>
              </span>
              <input className="field mt-1" maxLength={MAX_PLACE} value={place} placeholder={`For example: blog (empty: ${DEFAULT_PLACE})`} onChange={(event) => setPlace(event.target.value)} />
            </label>
            <label className="min-w-0">
              <span className="flex items-baseline justify-between gap-3">
                <span className="field-label">Campaign</span>
                <span className="text-xs text-ink-mute">Optional</span>
              </span>
              <input className="field mt-1" maxLength={MAX_CAMPAIGN} value={campaign} placeholder="For example: spring-launch" onChange={(event) => setCampaign(event.target.value)} />
            </label>
          </div>
          <p className="mt-2 text-sm text-ink-soft">
            {`Sales made through it carry utm_source “${embedPlace(place)}”${campaign.trim() ? " and your campaign" : ""}, listed under Where the money came from in your numbers and sent with each sale.completed webhook.`}
          </p>

          <label className="mt-4 block">
            <span className="flex items-baseline justify-between gap-3">
              <span className="field-label">{forSignup ? "Page to send them back to" : "Page to send the buyer back to after paying"}</span>
              <span className="text-xs text-ink-mute">Optional</span>
            </span>
            <input className="field mt-1" value={back} inputMode="url" placeholder="https://www.example.com/thank-you" onChange={(event) => setBack(event.target.value)} />
          </label>
          <p className="mt-2 text-sm text-ink-soft">
            {backOk
              ? forSignup
                ? "Shown as a link under the confirmation when the form opens as a page. It has to be on one of your sites."
                : "The receipt page shows a button back to it. With the script on that page, it hears marktmorgen:purchase. It has to be on one of your sites."
              : "That page is not on one of your saved sites, so the code leaves it out. Add its site above and save first."}
          </p>

          <fieldset className="mt-5 min-w-0">
            <legend className="field-label">Opens</legend>
            <div className="mt-2 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              {(
                [
                  ["overlay", "Over your page", "Your page stays where it is. Stripe's checkout opens in a new tab."],
                  ["page", "As a page", "The same tab moves on to the card, then to Stripe. Works in every builder, even those that frame pasted code."],
                ] as const
              ).map(([value, title, body]) => (
                <label key={value} className={`flex cursor-pointer gap-3 rounded-2xl p-4 ${mode === value ? "bg-lilac ring-2 ring-violet-brand" : "bg-paper ring-1 ring-line"}`}>
                  <input type="radio" name="script-mode" value={value} checked={mode === value} onChange={() => setMode(value)} className="mt-1 h-4 w-4 shrink-0" />
                  <span>
                    <span className="block font-semibold text-ink">{title}</span>
                    <span className="mt-0.5 block text-sm text-ink-soft">{body}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {colorsChanged ? (
            <p className="mt-3 text-sm text-ink-soft">
              These colors are hard to read. The code uses readable colors so the words are clear.{" "}
              <Link href="/studio#look" prefetch={false} className="font-semibold underline underline-offset-4">Choose another store color</Link>.
            </p>
          ) : null}

          <label className="mt-6 block">
            <span className="field-label">The code to paste</span>
            <textarea className="field mt-1 font-mono text-xs" rows={8} readOnly value={code} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void copy()}>
              <Icon name={copied ? "check" : "window"} size={15} />
              {copied ? "Copied" : "Copy the code"}
            </button>
            <Link href="/developers/checkout-script" target="_blank" className="btn btn-secondary btn-sm">
              <Icon name="external" size={15} />
              What it does, and its events
            <NewTab /></Link>
          </div>
          <p className="mt-3 text-sm text-ink-soft">
            The link works on its own, without the script. Paste the script once per page: every link on the page shares it. It sets no cookie,
            reads nothing on your page but its own links, and nothing is asked of Marktmorgen until someone presses one. Each person who presses
            one counts as a visit to your store, once a day.
          </p>

          <div className="mt-6 rounded-2xl bg-paper p-4 ring-1 ring-line">
            <p className="font-semibold text-ink">Where to paste it</p>
            <ul className="mt-2 space-y-2 text-sm text-ink-soft">
              {BUILDERS.map((builder) => (
                <li key={builder.name}>
                  <span className="font-semibold text-ink">{builder.name}. </span>
                  {`${builder.where} ${builder.policy}`}
                </li>
              ))}
            </ul>
            <p className="mt-4 font-semibold text-ink">If your site sends a Content-Security-Policy</p>
            <p className="mt-1 text-sm text-ink-soft">Add these to it. The hash is the script&apos;s own, so it changes only with a new version of the script.</p>
            <pre tabIndex={0} role="region" aria-label="Content Security Policy directives" className="mt-2 overflow-x-auto rounded-xl bg-white p-3 font-mono text-xs text-ink ring-1 ring-line">{hash ? cspLines(hash).join("\n") : "Working out the hash…"}</pre>
          </div>
        </>
      ) : (
        <p className="mt-6 text-ink-soft">Add a product, or switch on the sign-up box on your store page, and its code shows here.</p>
      )}
    </div>
  );
}
