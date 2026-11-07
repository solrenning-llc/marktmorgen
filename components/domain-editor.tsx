"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { NewTab } from "@/components/new-tab";

type DnsRecord = { type: "A" | "CNAME" | "TXT"; name: string; value: string; why: string };
type Status = { name: string; live: boolean; records: DnsRecord[] };

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  shape: "That is not a domain we can use. Type it like shop.yourname.com or yourname.com, without https://.",
  taken: "Another store here already uses that domain.",
  elsewhere: "That domain is connected to a site somewhere else. Remove it there first, then add it here.",
  has_one: "Your store already has a domain. Remove it first to add another.",
  plan: "Your own domain is part of Pro.",
  unavailable: "Domains are not answering just now. Nothing was changed; try again in a moment.",
  unfinished: "Your store no longer opens on this domain, but removing it did not finish. Try removing it again in a moment.",
  none: "There is no domain on your store yet.",
  signed_out: "Your session ended. Log in again.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

async function call(payload: Record<string, unknown>) {
  try {
    const response = await fetch("/api/store/domain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as {
      ok?: boolean;
      error?: string;
      status?: Status | null;
    };
  } catch {
    return { ok: false, error: "server_error" };
  }
}

/** Adding the creator's own domain, and the records their domain provider needs. */
export function DomainEditor({
  handle,
  domain,
  live,
  initial,
}: {
  handle: string;
  domain: string | null;
  live: boolean;
  initial: Status | null;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [status, setStatus] = useState<Status | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [removing, setRemoving] = useState(false);

  const act = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const answer = await call(payload);
    setBusy(false);
    if (!answer.ok) {
      setError(MESSAGES[answer.error ?? ""] ?? MESSAGES.server_error);
      return false;
    }
    setStatus(answer.status ?? null);
    return true;
  };

  if (!domain) {
    return (
      <form
        className="mt-4 space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await act({ action: "connect", name })) router.refresh();
        }}
      >
        <label className="block">
          <span className="field-label">Your domain</span>
          <input
            className="field mt-2"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="shop.yourname.com"
            maxLength={253}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p className="text-sm text-ink-soft">
          {`A domain you already own, bought wherever you like. Your store opens on it, and marktmorgen.com/@${handle} keeps working as well.`}
        </p>
        <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary">
          Add the domain
        </button>
        {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
      </form>
    );
  }

  const shown = status ?? null;
  const isLive = shown ? shown.live : live;
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 break-all font-semibold text-ink">{domain}</p>
        <span className={`tag ${isLive ? "tag-live" : ""}`}>{isLive ? "Live" : "Waiting for your records"}</span>
      </div>
      {isLive ? (
        <p className="mt-2 text-ink-soft">
          Your store opens on{" "}
          <a className="underline underline-offset-2" href={`https://${domain}`} target="_blank" rel="noreferrer">
            {`https://${domain}`}
          <NewTab /></a>
          , with its own certificate.
        </p>
      ) : (
        <p className="mt-2 text-ink-soft">
          Add the record{shown && shown.records.length > 1 ? "s" : ""} below where you bought the domain, in its DNS settings. It
          usually takes a few minutes to show, and can take up to 48 hours. Then press Check again. The domain is held for your store for three
          days while you do this.
        </p>
      )}

      {shown && !shown.live ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[20rem] text-left text-sm">
            <caption className="sr-only">DNS records to add</caption>
            <thead>
              <tr className="text-ink-mute">
                <th scope="col" className="py-2 pr-3 font-semibold">Type</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Name</th>
                <th scope="col" className="py-2 font-semibold">Value</th>
              </tr>
            </thead>
            <tbody>
              {shown.records.map((r) => (
                <tr key={`${r.type}-${r.name}`} className="border-t border-line align-top">
                  <td className="py-2 pr-3 font-semibold text-ink">{r.type}</td>
                  <td className="py-2 pr-3 break-all font-mono text-ink">{r.name}</td>
                  <td className="py-2 break-all font-mono text-ink">
                    {r.value}
                    <span className="mt-1 block font-sans text-ink-soft">{r.why}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          aria-busy={busy} disabled={busy}
          className="btn btn-secondary"
          onClick={async () => {
            if (await act({ action: "check" })) {
              setChecked(true);
              router.refresh();
            }
          }}
        >
          Check again
        </button>
        {removing ? (
          <>
            <button
              type="button"
              aria-busy={busy} disabled={busy}
              className="btn btn-secondary"
              onClick={async () => {
                if (await act({ action: "remove" })) {
                  setStatus(null);
                  setRemoving(false);
                  toast("Domain removed.");
                  router.refresh();
                }
              }}
            >
              Yes, remove it
            </button>
            <button type="button" className="text-sm font-bold text-ink-soft underline underline-offset-4" onClick={() => setRemoving(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button
            type="button"
            className="text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger"
            onClick={() => setRemoving(true)}
          >
            Remove the domain
          </button>
        )}
      </div>
      {removing ? (
        <p className="mt-2 text-sm text-ink-soft">
          {`${domain} stops opening your store. marktmorgen.com/@${handle} carries on as before.`}
        </p>
      ) : null}
      {checked && shown && !shown.live && !error ? (
        <p className="notice mt-3" role="status">Not there yet. Records can take a while to show; check again in a few minutes.</p>
      ) : null}
      {error ? <p className="notice notice-error mt-3" role="alert">{error}</p> : null}
    </div>
  );
}
