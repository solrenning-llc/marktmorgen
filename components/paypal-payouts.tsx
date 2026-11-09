"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { NewTab } from "@/components/new-tab";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { formatMoney } from "@/lib/money";
import { ordinal } from "@/lib/affiliate-setting";

type View = { client: string; at: number; auto: boolean; broken: boolean };
/** A payment PayPal could not confirm, left for the creator's own check (lib/paypal-payouts.ts, paypalOwnChecks). */
export type OwnCheckView = { id: string; at: number; currency: string; people: { id: string; email: string; cents: number }[] };

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  format: "That does not look like a PayPal Client ID and Secret. Copy both again from your app in PayPal's developer dashboard.",
  refused: "PayPal did not accept that Client ID and Secret. Check they are the Live ones, not Sandbox, and copy them again.",
  "no-payouts": "PayPal says Payouts is not switched on for that app. Turn on Payouts for the app (PayPal may ask you to request it first), then connect again.",
  seal: "Secrets cannot be stored safely on this deployment right now, so nothing was kept.",
  "not-connected": "Connect your PayPal first.",
  reconnect: "Connect your PayPal app again: its Secret has to be entered once more.",
  nothing: "Nobody is owed anything that has cleared right now.",
  refunds: "We could not check every refund on your Stripe account just now, so nothing was sent. Try again in a minute.",
  funds: "Your PayPal balance does not cover this batch. Nothing was sent. Add money to your PayPal balance and try again.",
  busy: "A payment is being sent right now. Wait a moment and reload.",
  off: "Switch your affiliate program on first.",
  slow: "Too many tries for now. Try again in an hour.",
  error: "PayPal could not be reached. Nothing was sent. Try again in a moment.",
  unknown: "We sent the batch to PayPal, but its answer did not reach us, so we do not know whether it was paid. Nobody in it will be sent again: they show as on their way. Look at your PayPal activity to see whether it went.",
  gone: "That payment was already sorted out. Reload the page to see where things stand.",
  changed: "Your answers no longer match that payment. Reload the page and answer again.",
  "own-error": "Your answers were not saved, and nothing was sent. Try again in a moment.",
  pending: "Nobody was paid just now. But we could not confirm that this payment was cleared from our records, so our daily check may still send it from your PayPal, to the same people for the same amounts. Until then, they show as on their way. Do not pay them another way, or they could be paid twice.",
};

async function send(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch("/api/store/affiliates/paypal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return (await response.json().catch(() => ({ ok: false, error: "error" }))) as Record<string, unknown>;
}

/**
 * Paying affiliates from the creator's own PayPal (lib/paypal-payouts.ts):
 * connect the app once, then one press — or payday by itself.
 */
export function PayPalPayouts({
  initial,
  people,
  cents,
  currency,
  onTheirWay,
  checking = 0,
  manualCheck = 0,
  ownChecks = [],
  payday,
}: {
  initial: View | null;
  /** Who can be paid right now, and how much in all. */
  people: number;
  cents: number;
  currency: string;
  /** Payments sent through PayPal and not yet confirmed. */
  onTheirWay: number;
  /** Of those, the ones whose answer from PayPal did not reach us, asked again once a day (lib/paypal-payouts.ts). */
  checking?: number;
  /** Of those, the ones PayPal could not confirm after a week, or said exist without saying which: not sent again. */
  manualCheck?: number;
  /** Those payments, one by one, for the creator to say what PayPal shows; null when they could not be read. */
  ownChecks?: OwnCheckView[] | null;
  /** The day of the month the creator pays; 0 when none is set. */
  payday: number;
}) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [client, setClient] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount = formatMoney(cents, currency);

  async function act(op: string, extra: Record<string, unknown> = {}) {
    setBusy(op);
    setError(null);
    const data = await send({ op, ...extra });
    setBusy(null);
    setSure(false);
    if (!data.ok) {
      // The server's own words first, where it gave them (a figure used, no place this month: lib/metered-limits.ts).
      const reason = op === "resolve" && data.error === "error" ? "own-error" : String(data.error);
      setError((typeof (data as { message?: unknown }).message === "string" && (data as { message: string }).message) || (MESSAGES[reason] ?? MESSAGES.error));
      return null;
    }
    return data;
  }

  return (
    <div className="mt-5 rounded-2xl border border-line bg-paper p-4">
      <h3 className="flex items-center gap-2 font-semibold text-ink">
        <Icon name="bank" size={18} />
        Pay from your own PayPal, in one press
      </h3>
      {!view ? (
        <>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">
            Connect an app from your PayPal Business account and we tell PayPal who to pay. Every payment goes from your PayPal
            balance to your affiliate&rsquo;s PayPal: it never passes through us, and you can take the connection away at any time.
          </p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-ink-soft">
            <li>Sign in at developer.paypal.com with your PayPal Business account.</li>
            <li>Under Apps &amp; Credentials, choose Live, then Create App.</li>
            <li>Keep Payouts switched on for the app. PayPal may ask you to request Payouts first; it usually answers within days.</li>
            <li>Copy the app&rsquo;s Client ID and Secret into the two boxes below.</li>
          </ol>
          <form
            className="mt-4 grid gap-3 sm:grid-cols-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const data = await act("connect", { client, secret });
              if (data) {
                setView(data.paypal as View);
                setClient("");
                setSecret("");
                toast("PayPal connected.");
              }
            }}
          >
            <label className="block">
              <span className="field-label">Client ID</span>
              <input className="field mt-1" value={client} onChange={(e) => setClient(e.target.value)} autoComplete="off" spellCheck={false} required />
            </label>
            <label className="block">
              <span className="field-label">Secret</span>
              <input className="field mt-1" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" required />
            </label>
            <div className="sm:col-span-2">
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy !== null}>
                {busy === "connect" ? "Checking with PayPal…" : "Connect PayPal"}
              </button>
              <p className="mt-2 text-xs text-ink-soft">
                We check it with PayPal, keep the Secret encrypted and never show it again. PayPal charges you its own fee on
                each payment, from your PayPal.
              </p>
            </div>
          </form>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-ink-soft">
            {`Connected: app ${view.client}, since ${new Date(view.at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.`}
          </p>
          {view.broken ? <p className="notice notice-warn mt-3 text-sm">{MESSAGES.reconnect}</p> : null}
          {people > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {!sure ? (
                <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null || view.broken} onClick={() => setSure(true)}>
                  {`Pay ${people} ${people === 1 ? "affiliate" : "affiliates"} ${amount} from my PayPal`}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy !== null}
                    onClick={async () => {
                      const data = await act("pay");
                      if (data) {
                        toast(`${formatMoney(Number(data.cents), currency)} sent to PayPal for ${data.people} ${Number(data.people) === 1 ? "affiliate" : "affiliates"}.`);
                        router.refresh();
                      }
                    }}
                  >
                    {busy === "pay" ? "Sending…" : `Yes, send ${amount} now`}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSure(false)}>
                    Not now
                  </button>
                </>
              )}
            </div>
          ) : (
            <p className="mt-3 text-sm text-ink-soft">Nobody is owed anything that has cleared right now.</p>
          )}
          {onTheirWay > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-ink-soft">
              <span>{`${onTheirWay} ${onTheirWay === 1 ? "payment is" : "payments are"} on the way through PayPal. Each shows as paid once PayPal confirms it; anyone PayPal cannot pay stays owed.`}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy !== null}
                onClick={async () => {
                  const data = await act("settle");
                  if (data) {
                    toast(Number(data.paid) ? `${data.paid} confirmed as paid.` : "Nothing new from PayPal yet.");
                    router.refresh();
                  }
                }}
              >
                Check with PayPal
              </button>
            </div>
          ) : null}
          {checking > 0 ? (
            <p className="mt-3 text-sm text-ink-soft" role="status">
              {`${checking} of these ${checking === 1 ? "is" : "are"} being checked with PayPal: we do not know yet whether PayPal has ${checking === 1 ? "this payment" : "these payments"}, so the same payment request is sent to PayPal once a day until it answers. Nobody is paid twice.`}
            </p>
          ) : null}
          {manualCheck > 0 ? (
            <div className="notice notice-warn mt-3 text-sm">
              <p role="status">
                {`PayPal could not confirm ${manualCheck} ${manualCheck === 1 ? "payment" : "payments"}, so we will not send ${manualCheck === 1 ? "it" : "them"} again. Until you tell us what happened, the people in ${manualCheck === 1 ? "it" : "them"} show as on their way and are left out of new payments. Look each one up in `}
                <a className="underline underline-offset-2" href="https://www.paypal.com/myaccount/activities/" target="_blank" rel="noreferrer">
                  your PayPal activity
                  <NewTab />
                </a>
                {ownChecks && ownChecks.length ? ", then answer below." : ", then reload this page to answer."}
              </p>
              {ownChecks && ownChecks.length ? (
                <p className="mt-2">
                  If PayPal shows a payment as Pending or Unclaimed, wait until it is completed or returned before you answer.
                </p>
              ) : null}
              {(ownChecks ?? []).map((batch) => (
                <OwnCheckForm
                  key={batch.id}
                  batch={batch}
                  disabled={busy !== null}
                  saving={busy === "resolve"}
                  onSave={async (paid, unpaid) => {
                    const data = await act("resolve", { batch: batch.id, paid, unpaid });
                    if (data) {
                      toast(`${Number(data.paid)} written down as paid, ${Number(data.unpaid)} owed again.`);
                      router.refresh();
                    }
                    return data !== null;
                  }}
                />
              ))}
            </div>
          ) : null}
          <label className="mt-4 flex min-h-[44px] items-center gap-3 text-sm text-ink">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={view.auto}
              disabled={busy !== null || payday === 0}
              onChange={async (e) => {
                const data = await act("auto", { on: e.target.checked });
                if (data) setView(data.paypal as View);
              }}
            />
            <span>
              {payday
                ? `Pay by itself on the ${ordinal(payday)} of each month, your payday, and email me what was sent`
                : "Pay by itself on your payday: set a payday in your program's terms first"}
            </span>
          </label>
          <button
            type="button"
            className="btn btn-ghost btn-sm mt-2"
            disabled={busy !== null}
            onClick={async () => {
              const data = await act("disconnect");
              if (data) {
                setView(null);
                toast("PayPal disconnected. Its Secret is deleted.");
              }
            }}
          >
            Disconnect PayPal
          </button>
        </>
      )}
      {error ? (
        <p className="notice notice-error mt-3 text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One payment PayPal could not confirm: the creator says, person by person, what their PayPal activity shows, reviews
 * what that will do, and only then saves it (lib/paypal-payouts.ts, resolveOwnCheck). Nothing is sent to PayPal.
 */
function OwnCheckForm({
  batch,
  disabled,
  saving,
  onSave,
}: {
  batch: OwnCheckView;
  disabled: boolean;
  saving: boolean;
  onSave: (paid: string[], unpaid: string[]) => Promise<boolean>;
}) {
  const id = useId();
  const [answers, setAnswers] = useState<Record<string, "paid" | "unpaid">>({});
  const [sure, setSure] = useState(false);
  const [missing, setMissing] = useState(false);
  const money = (cents: number) => formatMoney(cents, batch.currency);
  const sent = new Date(batch.at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const total = batch.people.reduce((n, p) => n + p.cents, 0);
  const paid = batch.people.filter((p) => answers[p.id] === "paid");
  const unpaid = batch.people.filter((p) => answers[p.id] === "unpaid");
  const sum = (list: typeof paid) => money(list.reduce((n, p) => n + p.cents, 0));
  const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

  return (
    <form
      className="mt-3 rounded-xl border border-line bg-white p-3 text-ink"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!sure) {
          if (paid.length + unpaid.length < batch.people.length) {
            setMissing(true);
            return;
          }
          setMissing(false);
          setSure(true);
          return;
        }
        const saved = await onSave(paid.map((p) => p.id), unpaid.map((p) => p.id));
        if (!saved) setSure(false);
      }}
    >
      <h4 className="font-semibold">{`Payment sent on ${sent}: ${money(total)} to ${people(batch.people.length)}`}</h4>
      <p className="mt-1">What does your PayPal activity show?</p>
      {batch.people.map((person) => (
        <fieldset key={person.id} className="mt-3" disabled={disabled || sure}>
          <legend className="font-medium">{`${person.email}, ${money(person.cents)}`}</legend>
          <div className="mt-1 flex flex-wrap gap-x-6">
            {(["paid", "unpaid"] as const).map((value) => (
              <label key={value} className="flex min-h-[44px] items-center gap-2">
                <input
                  type="radio"
                  className="h-4 w-4"
                  name={`${id}-${person.id}`}
                  value={value}
                  checked={answers[person.id] === value}
                  onChange={() => setAnswers((before) => ({ ...before, [person.id]: value }))}
                />
                <span>{value === "paid" ? "PayPal paid them" : "PayPal did not pay them"}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      {missing ? (
        <p className="notice notice-error mt-3" role="alert">
          Choose an answer for everyone in this payment.
        </p>
      ) : null}
      {sure ? (
        <div className="mt-3" role="status">
          <p>
            {`If you save this, ${people(paid.length)} will be written down as paid (${sum(paid)}), and ${people(unpaid.length)} will be owed again (${sum(unpaid)}) and go in your next payment. Nothing is sent now.`}
          </p>
          {unpaid.length ? (
            <p className="mt-2 font-medium">
              Only choose &ldquo;PayPal did not pay them&rdquo; when PayPal shows the payment failed, was returned or was canceled,
              or does not show a payment to them at all.
              If PayPal did pay them, your next payment would pay them twice.
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary btn-sm" disabled={disabled}>
          {sure ? (saving ? "Saving…" : "Yes, save this") : "Review my answers"}
        </button>
        {sure ? (
          <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={() => setSure(false)}>
            Go back and change them
          </button>
        ) : null}
      </div>
    </form>
  );
}
