"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import type { ServerSetup } from "@/lib/ad-events";

type Platform = "meta" | "tiktok" | "google" | "pinterest";

const PLATFORMS: { id: Platform; name: string; field: string; where: string }[] = [
  {
    id: "meta",
    name: "Meta",
    field: "Meta access token",
    where: "Meta Events Manager: your pixel, Settings, Conversions API, “Generate access token”.",
  },
  {
    id: "tiktok",
    name: "TikTok",
    field: "TikTok access token",
    where: "TikTok Events Manager: your pixel, Settings, Events API, “Generate access token”.",
  },
  {
    id: "google",
    name: "Google",
    field: "Measurement Protocol API secret",
    where: "Google Analytics: Admin, Data streams, your web stream, Measurement Protocol API secrets, Create.",
  },
  {
    id: "pinterest",
    name: "Pinterest",
    field: "Pinterest conversion access token",
    where: "Pinterest Ads Manager: your ad account, Conversions, Conversions API, “Set up API”, where the token is made.",
  },
];

const KIND_NAMES = { purchase: "purchase", renewal: "renewal", lead: "sign-up" } as const;

/**
 * Sending conversions from our server as well as from the buyer's browser
 * (lib/ad-events.ts): one access token per platform, pasted once, sealed, and
 * never shown again; Pinterest's with the ad account its events go to.
 */
export function ServerEventsEditor({ setup, pixels, googleId }: { setup: ServerSetup; pixels: Record<Platform, boolean>; googleId: string }) {
  const [state, setState] = useState(setup);
  const [tokens, setTokens] = useState<Record<Platform, string>>({ meta: "", tiktok: "", google: "", pinterest: "" });
  const [account, setAccount] = useState(setup.pinterestAccount);
  const [testCode, setTestCode] = useState(setup.testCode);
  const [busy, setBusy] = useState(false);
  // Google's Measurement Protocol takes a Google Analytics id (G-), not an Ads one.
  const analytics = /^G-/.test(googleId);

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/store/ads-server", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; setup?: ServerSetup; error?: string };
      if (answer.ok && answer.setup) {
        setState(answer.setup);
        toast(done);
        return true;
      }
      toast(
        answer.error === "token"
          ? "That does not look like a token. Copy the whole of it from where it was made."
          : answer.error === "account"
            ? "Add your Pinterest ad account ID: the number in Ads Manager, under your account's name."
            : answer.error === "code"
              ? "A test code looks like TEST12345."
              : answer.error === "saved_unread"
                ? "Saved. The setup could not be read back just now; reload the page."
                : "That did not save. Try again.",
      );
    } catch {
      toast("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
    return false;
  }

  const shown = PLATFORMS.filter((p) => pixels[p.id]);
  if (!shown.length) return null;
  const last = state.last;
  return (
    <section id="server-events" aria-labelledby="server-events-title" className="card mt-8 p-6 sm:p-8">
      <h2 id="server-events-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        Send conversions from our server too
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-soft">
        A pixel in the browser misses part of your sales: blockers, Safari, in-app browsers, and buyers who close the tab
        before your thanks page. With a token below, we send each purchase to that platform from our server the moment Stripe
        confirms the payment, with the same order id as the pixel, so it is counted once and marked as a new or returning
        customer. Membership renewals go as purchases of their own, and free sign-ups as leads. Only for buyers who allowed ad
        measurement on your store: never where they said no, and never without a yes where the law asks first.
      </p>
      <div className="mt-5 space-y-6">
        {shown.map((p) => {
          const blocked = p.id === "google" && !analytics;
          return (
            <form
              key={p.id}
              className="space-y-2"
              onSubmit={async (event) => {
                event.preventDefault();
                const body: Record<string, unknown> = { platform: p.id, token: tokens[p.id] };
                if (p.id === "pinterest") body.account = account;
                if (await send(body, `${p.name} token saved.`)) setTokens((t) => ({ ...t, [p.id]: "" }));
              }}
            >
              <p className="text-sm font-semibold text-ink">
                {p.name}
                <span className={`ml-2 text-xs font-semibold ${state.on[p.id] ? "text-mint-deep" : "text-ink-soft"}`}>
                  {state.on[p.id] ? "On: a token is saved" : "Off"}
                </span>
              </p>
              {blocked ? (
                <p className="text-xs text-ink-soft">
                  Google takes conversions from the server through Google Analytics. Put your Google Analytics tag ID (it starts
                  with G-) in the Google field above, then add its API secret here. Purchases reach Google Ads when your
                  Analytics property is linked to it and the purchase is imported as a conversion.
                </p>
              ) : (
                <>
                  {p.id === "pinterest" ? (
                    <label className="block text-sm">
                      <span className="field-label">Pinterest ad account ID</span>
                      <input
                        inputMode="numeric"
                        autoComplete="off"
                        className="field mt-1 py-2"
                        value={account}
                        maxLength={20}
                        onChange={(e) => setAccount(e.target.value.replace(/\D/g, ""))}
                        placeholder="549755885175"
                      />
                    </label>
                  ) : null}
                  <label className="block text-sm">
                    <span className="field-label">{p.field}</span>
                    <input
                      type="password"
                      autoComplete="off"
                      className="field mt-1 py-2"
                      value={tokens[p.id]}
                      onChange={(e) => setTokens((t) => ({ ...t, [p.id]: e.target.value }))}
                      placeholder={state.on[p.id] ? "Saved. Paste a new one to replace it." : "Paste it here"}
                    />
                  </label>
                  <p className="text-xs text-ink-soft">
                    {`Where: ${p.where} It is sealed before it is kept and never shown again.`}
                    {p.id === "google"
                      ? " Purchases and renewals go to your Analytics property, on the buyer's own visit, and reach Google Ads when the property is linked and the purchase is imported as a conversion. Sign-ups are not sent to Google, which could count them twice."
                      : ""}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !tokens[p.id].trim()}>
                      Save token
                    </button>
                    {state.on[p.id] ? (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void send({ platform: p.id, token: "" }, `${p.name} turned off.`)}>
                        Turn off
                      </button>
                    ) : null}
                  </div>
                </>
              )}
            </form>
          );
        })}
        {pixels.meta ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send({ testCode }, testCode ? "Test code saved." : "Test code cleared.");
            }}
          >
            <label className="text-sm">
              <span className="field-label">Meta test event code (optional)</span>
              <input className="field mt-1 w-auto py-2" value={testCode} maxLength={14} onChange={(e) => setTestCode(e.target.value)} placeholder="TEST12345" />
            </label>
            <button type="submit" className="btn btn-ghost btn-sm" disabled={busy}>
              Save
            </button>
            <p className="w-full text-xs text-ink-soft">
              While it is set, conversions appear under Test events in Meta Events Manager so you can see them arrive. Clear it
              when you have.
            </p>
          </form>
        ) : null}
        {last ? (
          <p className="text-xs text-ink-soft" data-server-last="">
            {`Last ${KIND_NAMES[last.kind ?? "purchase"]} sent ${new Date(last.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}: `}
            {PLATFORMS.filter((p) => last[p.id])
              .map((p) => `${p.name}: ${last[p.id]}`)
              .join(" · ")}
          </p>
        ) : null}
      </div>
    </section>
  );
}
