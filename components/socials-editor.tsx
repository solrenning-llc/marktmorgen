"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { Icon } from "@/components/icons";
import {
  MAX_SOCIALS,
  SOCIALS,
  SOCIAL_NETWORKS,
  type Social,
  type SocialNetwork,
  isSocialNetwork,
  networkFor,
  parseSocials,
  socialShown,
  socialUrl,
  typedOf,
} from "@/lib/store-socials";

type Row = { key: number; network: SocialNetwork; typed: string };

const PLACEHOLDER: Partial<Record<SocialNetwork, string>> = {
  email: "you@example.com",
  website: "https://example.com",
  whatsapp: "Country code and number",
  spotify: "https://open.spotify.com/…",
  discord: "https://discord.gg/…",
  substack: "yourname",
};

const UNCONFIRMED = "We could not confirm whether your profiles were saved. Reload this page to check before trying again.";

const MESSAGES: Record<string, string> = {
  too_many: `A store shows up to ${MAX_SOCIALS} profiles.`,
  not_a_profile: "One of the profiles is not an address for its network. It is marked below.",
  signed_out: "Your session ended. Log in again.",
  forbidden: "Your role in this store cannot change its page.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
};

/** What to say under a box whose words make no address for its network. */
function problem(network: SocialNetwork): string {
  const name = SOCIALS[network].label;
  if (network === "email") return "This is not a whole email address yet.";
  if (network === "website") return "This is not a web address yet. It needs to start with https:// or be like example.com.";
  if (!SOCIALS[network].profile) return `Paste the whole address of your ${name} page, starting with https://.`;
  return `This is not a ${name} handle or a ${name} address. Only addresses on ${name} itself are linked.`;
}

/**
 * The keyboard and autofill of a profile's field (487 [IT4], item 2): the
 * phone keyboard and the person's own number for WhatsApp, the email keyboard
 * and their own address for email; a handle or a link is not filled in. Each
 * row is its own autofill section (`section-profile-<row>`), so choosing a
 * suggestion in one row never fills another: an address never lands in a
 * WhatsApp row, nor a phone number in an email row, to be shown on the store.
 */
export function profileKeyboard(network: SocialNetwork, row: number): { type: "email" | "text"; inputMode?: "tel"; autoComplete: string } {
  const section = `section-profile-${row}`;
  if (network === "email") return { type: "email", autoComplete: `${section} email` };
  if (network === "whatsapp") return { type: "text", inputMode: "tel", autoComplete: `${section} tel` };
  return { type: "text", autoComplete: "off" };
}

/**
 * The creator's profiles elsewhere (lib/store-socials.ts), shown under the
 * store's name. A handle or a pasted address both work: a pasted address
 * picks its own network, and each box says where its link will go before
 * anything is saved.
 */
export function SocialsEditor({ socials }: { socials: Social[] }) {
  const router = useRouter();
  const start = (): Row[] => socials.map((s, i) => ({ key: i, network: s.network, typed: typedOf(s) }));
  const [rows, setRows] = useState<Row[]>(start);
  const [next, setNext] = useState(socials.length);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [bad, setBad] = useState<number[]>([]);
  const used = useMemo(() => new Set(rows.map((r) => r.network)), [rows]);

  function add() {
    const network = SOCIAL_NETWORKS.find((n) => !used.has(n)) ?? "website";
    setRows([...rows, { key: next, network, typed: "" }]);
    setNext(next + 1);
  }

  function change(key: number, part: Partial<Row>) {
    setBad([]);
    setRows(rows.map((r) => {
      if (r.key !== key) return r;
      const row = { ...r, ...part };
      // A pasted address names its own network.
      if (part.typed !== undefined) {
        const found = /[./@]/.test(part.typed) ? networkFor(part.typed) : null;
        if (found && found !== row.network && !socialUrl(row.network, part.typed)) row.network = found;
      }
      return row;
    }));
  }

  function move(index: number, by: -1 | 1) {
    const to = index + by;
    if (to < 0 || to >= rows.length) return;
    const copy = [...rows];
    [copy[index], copy[to]] = [copy[to], copy[index]];
    setRows(copy);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const kept = rows.filter((r) => r.typed.trim());
    setSaving(true);
    setError("");
    setBad([]);
    try {
      const response = await fetch("/api/store/socials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ socials: kept.map((r) => ({ network: r.network, url: r.typed })) }),
      });
      const raw: unknown = await response.json();
      const data: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const expected = parseSocials(kept.map(row=>({network:row.network,url:row.typed})));
      const matches = Array.isArray(data.socials) && data.socials.length === expected.length && data.socials.every((entry:unknown,index:number)=>{
        const value = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string,unknown> : {};
        return value.network === expected[index].network && value.url === expected[index].url;
      });
      if (response.ok && data.ok === true && data.error === undefined && kept.length <= MAX_SOCIALS && kept.every(row=>Boolean(socialUrl(row.network,row.typed))) && matches) {
        setRows(kept);
        setOpen(false);
        toast(kept.length ? "Profiles saved." : "Profiles removed from your store.");
        router.refresh();
        return;
      }
      const rejected = data.error === "not_a_profile" && Array.isArray(data.bad) ? data.bad.slice(0,MAX_SOCIALS).filter((index):index is number=>typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < kept.length).map(index=>kept[index].key) : [];
      setBad(rejected);
      setError(typeof data.error === "string" && Object.hasOwn(MESSAGES,data.error) && (data.error !== "not_a_profile" || rejected.length > 0) ? MESSAGES[data.error] : UNCONFIRMED);
    } catch {
      setError(UNCONFIRMED);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div>
        {socials.length ? (
          <ul className="flex flex-wrap gap-2">
            {socials.map((s) => (
              <li key={s.url} className="inline-flex items-center gap-1.5 rounded-full bg-paper px-3 py-1 text-xs font-semibold text-ink ring-1 ring-line">
                <Icon name={SOCIALS[s.network].icon} size={13} />
                {SOCIALS[s.network].label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-soft">Add your Instagram, TikTok, YouTube and the rest, so buyers can follow you from your store.</p>
        )}
        <button
          type="button"
          onClick={() => {
            setRows(start());
            setOpen(true);
            if (socials.length === 0) {
              setRows([{ key: next, network: "instagram", typed: "" }]);
              setNext(next + 1);
            }
          }}
          className="mt-2 text-sm font-bold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep"
        >
          {socials.length ? "Edit your profiles" : "Add your profiles"}
        </button>
      </div>
    );
  }

  return (
    <form data-socials-editor onSubmit={save} aria-busy={saving} className="space-y-3" noValidate>
      <p className="text-sm text-ink-soft">Type a handle like @yourname, or paste the address of your profile: the network is picked for you.</p>
      <ol className="space-y-3">
        {rows.map((row, index) => {
          const url = row.typed.trim() ? socialUrl(row.network, row.typed) : "";
          const wrong = (row.typed.trim() && !url) || bad.includes(row.key);
          const id = `social-${row.key}`;
          return (
            <li key={row.key} className="rounded-[12px] bg-paper p-3 ring-1 ring-line">
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-36 shrink-0">
                  <label htmlFor={`${id}-network`} className="field-label">Network</label>
                  <select
                    id={`${id}-network`}
                    disabled={saving}
                    value={row.network}
                    onChange={(e) => isSocialNetwork(e.target.value) && change(row.key, { network: e.target.value })}
                    className="field mt-1"
                  >
                    {SOCIAL_NETWORKS.map((n) => (
                      <option key={n} value={n}>{SOCIALS[n].label}</option>
                    ))}
                  </select>
                </div>
                <div className="min-w-0 flex-1">
                  <label htmlFor={`${id}-value`} className="field-label">
                    {row.network === "email" ? "Address" : SOCIALS[row.network].profile ? "Handle or address" : "Address"}
                  </label>
                  <input
                    id={`${id}-value`}
                    disabled={saving}
                    type={row.network === "email" ? "email" : "text"}
                    inputMode={profileKeyboard(row.network, row.key).inputMode}
                    autoComplete={profileKeyboard(row.network, row.key).autoComplete}
                    spellCheck={false}
                    value={row.typed}
                    placeholder={PLACEHOLDER[row.network] ?? "@yourname"}
                    onChange={(e) => change(row.key, { typed: e.target.value })}
                    aria-invalid={wrong ? true : undefined}
                    aria-describedby={`${id}-note`}
                    className="field mt-1"
                  />
                </div>
                <div className="flex gap-1">
                  <button type="button" onClick={() => move(index, -1)} disabled={saving || index === 0} className="btn btn-ghost btn-sm" aria-label={`Move ${SOCIALS[row.network].label} up`}>
                    <Icon name="chevron-down" size={16} className="rotate-180" />
                  </button>
                  <button type="button" onClick={() => move(index, 1)} disabled={saving || index === rows.length - 1} className="btn btn-ghost btn-sm" aria-label={`Move ${SOCIALS[row.network].label} down`}>
                    <Icon name="chevron-down" size={16} />
                  </button>
                  <button type="button" onClick={() => setRows(rows.filter((r) => r.key !== row.key))} disabled={saving} className="btn btn-ghost btn-sm" aria-label={`Remove ${SOCIALS[row.network].label}`}>
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </div>
              <p id={`${id}-note`} className={`mt-1.5 break-all text-xs ${wrong ? "font-semibold text-danger-text" : "text-ink-soft"}`}>
                {wrong
                  ? problem(row.network)
                  : url
                    ? `Opens ${socialShown(url)}`
                    : "Empty boxes are left out."}
              </p>
            </li>
          );
        })}
      </ol>
      {rows.length < MAX_SOCIALS ? (
        <button type="button" onClick={add} disabled={saving} className="btn btn-secondary btn-sm">
          <Icon name="plus" size={16} />
          Add a profile
        </button>
      ) : (
        <p className="text-sm text-ink-soft">{`That is the most a store shows: ${MAX_SOCIALS}.`}</p>
      )}
      {error ? <p role="alert" className="text-sm font-semibold text-danger-text">{error}</p> : null}
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={saving} className="btn btn-primary btn-sm">{saving ? "Saving…" : "Save profiles"}</button>
        <button type="button" onClick={() => { setOpen(false); setError(""); setBad([]); }} disabled={saving} className="btn btn-ghost btn-sm">Cancel</button>
      </div>
    </form>
  );
}
