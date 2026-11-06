"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import { UrlField } from "@/components/url-field";
import { type ChatKind, MAX_CHAT_URL, chatKind } from "@/lib/chat-kind";
import { type LinkCheck, checkWith } from "@/lib/url-check";

const ANSWERS: Record<string, string> = {
  invalid: "That is not a Slack or Discord webhook address. It starts with https://hooks.slack.com/services/ or https://discord.com/api/webhooks/.",
  refused: "The channel did not take a first message at that address. Check it was copied whole and the webhook is still on.",
  rate_limited: "That is a lot of tries in an hour. Try again later.",
};

// The address, checked when its field is left by the same reading the server keeps (lib/chat-kind.ts), and required:
// an empty one sent here would stop the posting, which only "Stop posting" does.
const CHAT_SHAPE = checkWith((raw) => (chatKind(raw) ? raw.trim() : null), ANSWERS.invalid, MAX_CHAT_URL);
const CHAT_CHECK: LinkCheck = (raw) => (raw.trim() ? CHAT_SHAPE(raw) : { problem: ANSWERS.invalid, fix: null });

/** Where the weekly and monthly numbers are posted (lib/chat-summary.ts), for whoever may change settings. */
export function ChatSummaryEditor({ kind: given, sales: salesGiven = false }: { kind: ChatKind | null; sales?: boolean }) {
  const [kind, setKind] = useState(given);
  const [sales, setSales] = useState(salesGiven);

  async function saveSales(on: boolean) {
    setBusy(true);
    try {
      const response = await fetch("/api/store/chat-summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sales: on }) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; sales?: boolean };
      if (answer.ok) {
        setSales(answer.sales === true);
        toast(answer.sales ? "Each sale and each alert will be posted too." : "Only the week's and the month's numbers are posted now.");
      } else toast("That did not save. Try again in a moment.");
    } catch {
      toast("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(value: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/store/chat-summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: value }) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: string; error?: string };
      if (answer.ok) {
        setKind(answer.result === "saved" ? chatKind(value) : null);
        setUrl("");
        toast(answer.result === "saved" ? "Saved: a first message was posted to the channel" : "No longer posted");
      } else {
        toast(ANSWERS[answer.error ?? ""] ?? "That did not save. Try again in a moment.");
      }
    } catch {
      toast("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <p className="text-sm font-bold text-ink">Post the numbers to Slack or Discord</p>
      <p className="mt-1 text-xs text-ink-soft">
        {kind
          ? `The week's numbers go to your ${kind === "slack" ? "Slack" : "Discord"} channel every Monday, and the month's on the 1st. Stopping the emails does not stop these.`
          : "The week's numbers every Monday and the month's on the 1st, in the channel your team already reads. Paste an incoming webhook address: in Slack, Apps, Incoming Webhooks; in Discord, Server settings, Integrations, Webhooks."}
      </p>
      <form
        className="mt-3"
        onSubmit={(event) => {
          event.preventDefault();
          // Empty is never sent from here (it would stop the posting), nor an address the server would refuse:
          // each try counts in the hour's allowance. The field says what is wrong.
          if (url.trim() && !CHAT_CHECK(url).problem) save(url.trim());
        }}
      >
        <label htmlFor="chat-summary-url" className="field-label text-sm">{kind ? "A different webhook address" : "Webhook address"}</label>
        {/* The buttons line up with the field, not with its message under it. */}
        <div className="mt-1 flex flex-wrap items-start gap-2 text-sm">
          <UrlField
            id="chat-summary-url"
            className="field py-2"
            wrapClassName="min-w-0 flex-1"
            value={url}
            onChange={setUrl}
            check={CHAT_CHECK}
            placeholder="https://hooks.slack.com/services/…"
            autoComplete="off"
          />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          Save
        </button>
        {kind ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => save("")}>
            Stop posting
          </button>
        ) : null}
      </div>
      </form>
      {kind ? (
        <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 text-sm">
          <input type="checkbox" className="h-5 w-5 shrink-0 accent-[var(--violet)]" checked={sales} disabled={busy} onChange={(e) => void saveSales(e.target.checked)} />
          <span>
            <span className="block font-semibold text-ink">Also post each sale, and each alert</span>
            <span className="block text-xs text-ink-soft">
              One line per sale: the amount, what was bought and the channel it came from, never who bought it. And a line when
              visits or sales from them fall, refunds pile up, or the month&apos;s goal is off pace or reached.
            </span>
          </span>
        </label>
      ) : null}
    </div>
  );
}
