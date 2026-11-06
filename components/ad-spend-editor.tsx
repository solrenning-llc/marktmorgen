"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import { type AdSpend, typedOverlap } from "@/lib/ad-spend-rules";
import { formatMoney } from "@/lib/money";
import type { MetaAdsView } from "@/lib/meta-ads";
import { channelName } from "@/lib/channel-names";

/** The same as META_READ_PAUSED in lib/integration-pause.ts (232 [CA1] 4b3), written here so this browser file stays free of server code. */
const READ_PAUSED = "Reading it waits while your plan's renewal is unpaid or a payment for it is disputed, and starts again on its own once the payment is recorded or the dispute is won.";

function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The smallest units of an amount typed in the store's currency: "12.50" is 1250 cents, "¥500" in yen is 500. */
function toCents(raw: string, currency: string): number {
  const digits = raw.replace(/[^0-9.,]/g, "").replace(/,(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const decimals = new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return Math.round(value * 10 ** decimals);
}

const REASONS: Record<string, string> = {
  channel: "Choose where the ad ran.",
  amount: "Type what you spent, more than zero.",
  days: "Check the days: the first before the last, not in the future, and no more than 400 days apart.",
};

/** "October 13", for a day in UTC. */
function longDay(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/**
 * The store's Meta ad account (lib/meta-ads.ts): connect it, choose which
 * account is read, see when it was last read, disconnect. Shown only where
 * the deployment has a Meta app.
 */
function MetaAds({
  meta,
  lines,
  canConnect,
  pin,
  money,
  onChosen,
}: {
  meta: MetaAdsView;
  lines: AdSpend[];
  canConnect: boolean;
  pin: string;
  money: (cents: number) => string;
  onChosen: (meta: MetaAdsView, spends: AdSpend[]) => void;
}) {
  const [pick, setPick] = useState(meta.account?.id ?? meta.accounts.find((a) => a.currency === meta.currency)?.id ?? meta.accounts[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const read = meta.read;
  const soon = meta.expires > 0 && meta.expires * 1000 - nowMs() < 10 * 86_400_000;
  const connectForm = (label: string) =>
    canConnect ? (
      <form method="post" action={`/api/integrations/meta/start${pin}`} className="mt-2">
        <button type="submit" className="btn btn-secondary btn-sm">{label}</button>
      </form>
    ) : (
      <p className="mt-1 text-xs text-ink-soft">The store&apos;s owner or an Admin can connect it.</p>
    );

  async function choose() {
    setBusy(true);
    try {
      const response = await fetch("/api/store/meta-ads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "account", id: pick }) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; meta?: MetaAdsView; spends?: AdSpend[] };
      if (answer.ok && answer.meta && answer.spends) {
        onChosen(answer.meta, answer.spends);
        toast(answer.meta.readPaused ? `Chosen. ${READ_PAUSED}` : answer.meta.read?.day ? "Read from Meta." : "Chosen. It is read within the hour.");
      } else toast("That did not save. Try again.");
    } catch {
      toast("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-3 rounded-[10px] bg-white px-3 py-3 ring-1 ring-line" aria-labelledby="meta-ads-title" data-meta-ads>
      <h4 id="meta-ads-title" className="font-semibold text-ink">Read from your Meta ad account</h4>
      {!meta.connected ? (
        <>
          <p className="mt-1 text-xs text-ink-soft">
            Connect it and your numbers read what each campaign spent on Facebook, Instagram and Threads, day by day, once a
            day, instead of you typing it. Only what was spent is read: nothing about who saw or clicked your ads.
          </p>
          {connectForm("Connect Meta ads")}
        </>
      ) : meta.broken ? (
        <>
          <p className="mt-1 text-xs text-ink" role="status">{`Not read any more: ${meta.broken}. What was read before stays in your numbers.`}</p>
          {connectForm("Connect Meta ads again")}
        </>
      ) : !meta.account ? (
        <>
          <p className="mt-1 text-xs text-ink-soft">Your Meta login can read more than one ad account. Choose the one to read.</p>
          {canConnect ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="min-w-0">
                <span className="field-label">Ad account</span>
                <select className="field mt-1 min-w-0 max-w-full py-2" value={pick} onChange={(e) => setPick(e.target.value)}>
                  {meta.accounts.map((a) => (
                    <option key={a.id} value={a.id}>{`${a.name || a.id} (${a.currency.toUpperCase()})`}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !pick} onClick={() => void choose()}>
                Read this account
              </button>
            </div>
          ) : (
            <p className="mt-1 text-xs text-ink-soft">The store&apos;s owner or an Admin chooses it.</p>
          )}
        </>
      ) : (
        <>
          <p className="mt-1 text-xs text-ink">
            {`${meta.account.name || meta.account.id} (${meta.account.currency.toUpperCase()}). `}
            {read?.problem === "currency"
              ? `Not read: this ad account pays in ${meta.account.currency.toUpperCase()} and your store sells in ${meta.currency.toUpperCase()}, and no exchange rate is guessed.${meta.accounts.length > 1 ? " Choose an account in your store's currency below." : ""}`
              : read?.day
                ? `Read ${longDay(read.at)}: ${money(read.cents)} over the last 30 days${read.campaigns ? `, ${read.campaigns === 1 ? "1 campaign" : `${read.campaigns} campaigns`}` : ""}.${meta.readPaused ? ` ${READ_PAUSED}` : " Read again once a day."}${!meta.readPaused && read.problem ? " The last try did not reach Meta; it tries again within a few hours." : ""}`
                : meta.readPaused
                  ? READ_PAUSED
                  : read?.problem
                    ? "Meta could not be read yet; it tries again within a few hours."
                    : "Read for the first time within the hour."}
          </p>
          {lines.length ? (
            <p className="mt-1 text-xs text-ink-soft">
              {`Its lines are counted with what you type, on ${together([...new Set(lines.map((l) => channelName(l.channel)))])}. Each campaign's name is matched to your posts and campaigns as a utm_campaign is: tag your ads' links in Ads Manager with `}
              <code className="text-[11px]">{"utm_source={{site_source_name}}&utm_campaign={{campaign.name}}"}</code>
              {" and each campaign gets its own row."}
            </p>
          ) : null}
          {soon ? <p className="mt-1 text-xs text-ink" role="status">{`Meta asks for the permission again every 60 days or so: connect again before ${longDay(meta.expires)} to keep it read.`}</p> : null}
          {canConnect ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              {meta.accounts.length > 1 ? (
                <>
                  <label className="min-w-0">
                    <span className="field-label">Ad account</span>
                    <select className="field mt-1 min-w-0 max-w-full py-2" value={pick} onChange={(e) => setPick(e.target.value)}>
                      {meta.accounts.map((a) => (
                        <option key={a.id} value={a.id}>{`${a.name || a.id} (${a.currency.toUpperCase()})`}</option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy || pick === meta.account.id} onClick={() => void choose()}>
                    Read this one instead
                  </button>
                </>
              ) : null}
              {soon ? (
                <form method="post" action={`/api/integrations/meta/start${pin}`}>
                  <button type="submit" className="btn btn-secondary btn-sm">Connect again</button>
                </form>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      {meta.connected && canConnect ? (
        <form method="post" action={`/api/integrations/meta/disconnect${pin}`} className="mt-2">
          <button type="submit" className="btn btn-ghost btn-sm">Disconnect Meta ads</button>
          <span className="ml-2 text-xs text-ink-soft">Gives the permission back to Meta and deletes what was read.</span>
        </form>
      ) : null}
    </section>
  );
}

/** "Facebook", "Facebook and Instagram", "Facebook, Instagram and Threads". */
function together(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The time now, read outside rendering's rules. */
function nowMs(): number {
  return Date.now();
}

/**
 * What the creator spent on ads (lib/ad-spend-rules.ts), typed in by them:
 * where it ran, the post or campaign if they want it on that row too, the
 * amount and the days; and, where the store connected its Meta ad account,
 * what that account spent, read once a day (lib/meta-ads.ts). Each
 * channel's row then says what was left.
 */
export function AdSpendEditor({
  spends,
  onChange,
  channels,
  currency,
  today,
  meta: metaGiven = null,
  canConnectMeta = false,
  pin = "",
}: {
  spends: AdSpend[];
  onChange: (spends: AdSpend[]) => void;
  /** The channels the numbers know, offered first. */
  channels: { value: string; label: string }[];
  currency: string;
  today: string;
  /** The store's Meta ad account; null where the deployment has no Meta app. */
  meta?: MetaAdsView | null;
  canConnectMeta?: boolean;
  pin?: string;
}) {
  const [meta, setMeta] = useState(metaGiven);
  const typed = spends.filter((s) => s.source !== "meta");
  const fromMeta = spends.filter((s) => s.source === "meta");
  const overlap = typedOverlap(typed, fromMeta);
  const [open, setOpen] = useState(Boolean(metaGiven?.connected && !metaGiven.account && !metaGiven.broken));
  const [channel, setChannel] = useState(channels[0]?.value ?? "instagram");
  const [other, setOther] = useState("");
  const [campaign, setCampaign] = useState("");
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const money = (cents: number) => formatMoney(cents, currency);

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/store/spend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; spends?: AdSpend[]; error?: string };
      if (answer.ok && answer.spends) {
        onChange(answer.spends);
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

  return (
    <details className="mt-3 rounded-[12px] bg-paper px-4 py-3 text-sm ring-1 ring-line" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer font-semibold text-ink">
        {typed.length ? `What you spent on ads (${typed.length})` : meta?.connected ? "What you spent on ads" : "Add what you spent on ads"}
        {meta?.connected && !meta.broken && meta.account ? <span className="ml-1.5 font-normal text-ink-soft">· read from Meta</span> : null}
      </summary>
      <p className="mt-2 text-xs text-ink-soft">
        Type what an ad, a sponsored post or a promotion cost, and the days it ran. Each channel&apos;s row then shows what was
        left after it and what came back for every {money(100)}. An amount over several days is spread evenly over them.
        Only you and your team see these.
      </p>
      {meta ? (
        <MetaAds
          meta={meta}
          lines={fromMeta}
          canConnect={canConnectMeta}
          pin={pin}
          money={money}
          onChosen={(next, all) => {
            setMeta(next);
            onChange(all);
          }}
        />
      ) : null}
      {overlap.length ? (
        <p className="mt-2 text-xs text-ink" role="status">
          {`${overlap.length === 1 ? "1 line you typed falls" : `${overlap.length} lines you typed fall`} on ${together([...new Set(overlap.map((l) => channelName(l.channel)))])} on days Meta was read. If ${overlap.length === 1 ? "it is" : "they are"} the same ads, remove ${overlap.length === 1 ? "it" : "them"}, or the spend is counted twice.`}
        </p>
      ) : null}
      {typed.length ? (
        <ul className="mt-2 divide-y divide-line">
          {[...typed].reverse().map((spend) => (
            <li key={spend.id} className="flex items-baseline justify-between gap-3 py-1.5">
              <span className="min-w-0">
                <span className="font-semibold text-ink">{spend.channel}</span>
                {spend.campaign ? <span className="ml-1.5 text-ink-soft">{spend.campaign}</span> : null}
                <span className="ml-2 tabular-nums text-ink-soft">{`${money(spend.cents)} · ${shortDay(spend.from)}${spend.to !== spend.from ? ` to ${shortDay(spend.to)}` : ""}`}</span>
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm shrink-0"
                disabled={busy}
                onClick={() => void send({ action: "remove", id: spend.id }, "Removed.")}
                aria-label={`Remove ${money(spend.cents)} on ${spend.channel}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const where = channel === "~other" ? other : channel;
          const ok = await send({ action: "add", channel: where, campaign, cents: toCents(amount, currency), from, to }, "Added.");
          if (ok) {
            setAmount("");
            setCampaign("");
          }
        }}
      >
        <label className="min-w-0">
          <span className="field-label">Where it ran</span>
          <select className="field mt-1 min-w-0 max-w-full py-2" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {channels.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
            <option value="~other">Somewhere else…</option>
          </select>
        </label>
        {channel === "~other" ? (
          <label className="min-w-0">
            <span className="field-label">Its name, as in your links&apos; utm_source</span>
            <input required className="field mt-1 min-w-0 max-w-full py-2" maxLength={30} value={other} onChange={(e) => setOther(e.target.value)} placeholder="podcast-sponsor" />
          </label>
        ) : (
          <label className="min-w-0">
            <span className="field-label">Post or campaign (optional)</span>
            <input className="field mt-1 min-w-0 max-w-full py-2" maxLength={40} value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="october-reel" />
          </label>
        )}
        <label className="min-w-0">
          <span className="field-label">{`Amount (${currency.toUpperCase()})`}</span>
          <input required inputMode="decimal" className="field mt-1 min-w-0 max-w-full py-2" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="120.00" />
        </label>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="min-w-0 flex-1">
            <span className="field-label">First day</span>
            <input type="date" required className="field mt-1 min-w-0 max-w-full py-2" value={from} max={today} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="min-w-0 flex-1">
            <span className="field-label">Last day</span>
            <input type="date" required className="field mt-1 min-w-0 max-w-full py-2" value={to} max={today} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <div className="sm:col-span-2">
          <button type="submit" className="btn btn-secondary btn-sm" disabled={busy}>
            Add spend
          </button>
        </div>
      </form>
    </details>
  );
}
