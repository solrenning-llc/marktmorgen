"use client";

import { useEffect, useState } from "react";
import { toast } from "@/components/toast";
import { useStudioHref } from "@/components/studio-store-pin";
import type { Product } from "@/lib/store";
import { BUFFERS, DAY_NAMES, MAX_RANGES_PER_DAY, NOTICE_CHOICES, type Range, clock, fromClock } from "@/lib/call-setup";
import {
  DAILY_CAPS,
  TEAM_MODES,
  TEAM_MODE_NAMES,
  TEAM_MODE_SUMMARIES,
  type TeamHost,
  type TeamLimits,
  type TeamMode,
  type TeamSetup,
  HOST_LABEL_MAX,
  hostFromCall,
  teamLimitWords,
} from "@/lib/team-scheduling-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

type HostSyncView = { source: string; state: string; lastSuccess: number; message: string; blocked: boolean };

type View = {
  team: TeamSetup | null;
  owner: string;
  people: string[];
  limits: TeamLimits;
  others: number;
  closed: boolean;
  googleSync: boolean;
  sync: Record<string, HostSyncView>;
};

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  team_call: "Only a call with weekly hours and one person per time can be a team event.",
  team_mode: "Pick round robin or collective.",
  team_hosts: "Pick at least one host.",
  team_host: "Each host has to be someone on this store's team, once.",
  team_host_tz: "Pick each host's time zone.",
  team_host_hours: "Check each host's hours: at least one day, every stretch long enough for one call, the second starting after the first ends.",
  team_host_buffer: "Pick each host's gap between calls.",
  team_host_notice: "Pick each host's notice.",
  team_host_cap: "Pick each host's daily cap.",
  team_host_label: `Give each host a plain name buyers can see, up to ${HOST_LABEL_MAX} characters: no email address, link or website.`,
  team_pick: "To let buyers choose, use round robin and give every host a different name.",
  team_plan: "Team event types need a plan, or its free trial.",
  team_plan_hosts: "Your plan allows fewer hosts on one team event.",
  team_plan_types: "Your plan allows no more team event types. Stop another one first.",
  team_lengths: "A call that offers several lengths is booked on your own calendar. Keep one length in its hours first, then book it with your team.",
  team_not_member: "Someone picked is not on this store's team any more. Reload the page.",
  unknown: "That product is not a call any more. Reload the page.",
  signed_out: "Your session ended. Log in again.",
  role: "Your role cannot change products.",
  server_error: "Something went wrong on our side. Nothing was saved; try again in a moment.",
};

const SYNC_WORDS: Record<string, string> = {
  none: "no calendar read",
  ok: "calendar synced",
  stale: "calendar out of date: times hidden",
  failed: "calendar cannot be read: times hidden",
  scope: "Google permission missing: times hidden",
  off: "Google sync not switched on: times hidden",
};

function zones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list && list.length) return list;
  } catch {}
  return ["UTC"];
}

function hoursLabel(h: number): string {
  return h === 1 ? "1 hour" : `${h} hours`;
}

function ago(ms: number): string {
  if (!ms) return "never synced";
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return minutes < 1 ? "synced just now" : minutes < 120 ? `last synced ${minutes} min ago` : `last synced ${Math.round(minutes / 60)} h ago`;
}

/**
 * Makes a weekly one-to-one call a team event type (lib/team-scheduling-rules.ts):
 * round robin or collective, which people on the store's team host it, and
 * each host's own hours, time zone, gap, notice and daily cap. The plan's
 * numbers are shown and checked again on the server (app/api/store/call-team).
 */
export function TeamEventEditor({ product }: { product: Product }) {
  const href = useStudioHref();
  const setup = product.call;
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<TeamMode>("round_robin");
  // Round robin only: buyers choose who they book with, by each host's name, or "Any available" (520 [LB1], unit 6).
  const [pick, setPick] = useState(false);
  const [hosts, setHosts] = useState<TeamHost[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligible = Boolean(setup && setup.kind === "weekly" && setup.seats === 1);

  useEffect(() => {
    if (!eligible) return;
    let gone = false;
    fetch(`/api/store/call-team?product=${encodeURIComponent(product.id)}`)
      .then((r) => r.json())
      .then((data: { ok?: boolean } & View) => {
        if (gone) return;
        if (data.ok) setView(data);
        else setFailed(true);
      })
      .catch(() => {
        if (!gone) setFailed(true);
      });
    return () => {
      gone = true;
    };
  }, [eligible, product.id]);

  if (!eligible || !setup) return null;
  if (failed) return <p className="mt-3 text-sm text-ink-soft">The team for this call could not be read just now.</p>;
  if (!view) return null;

  const limits = view.limits;
  const roomForNew = view.team !== null || view.others < limits.eventTypes;

  function edit() {
    if (!view || !setup) return;
    setMode(view.team?.mode ?? "round_robin");
    setPick(view.team?.pick === true);
    setHosts(view.team ? view.team.hosts.map((h) => ({ ...h, weekly: h.weekly.map((d) => d.map((r) => [r[0], r[1]] as Range)) })) : [hostFromCall(view.owner, setup)]);
    setError(null);
    setOpen(true);
  }

  async function save(team: Omit<TeamSetup, "createdAt"> | null, done: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/call-team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: product.id, team }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; limit?: number } & Partial<View>;
      if (data.ok) {
        setView(data as View);
        setOpen(false);
        toast(done);
        return;
      }
      setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  function change(email: string, patch: Partial<TeamHost>) {
    setHosts(hosts.map((h) => (h.email === email ? { ...h, ...patch } : h)));
  }

  function setRange(email: string, day: number, index: number, part: 0 | 1, text: string) {
    const typed = fromClock(text);
    if (typed === null) return;
    const minutes = part === 1 && typed === 1439 ? 1440 : Math.round(typed / 5) * 5;
    const host = hosts.find((h) => h.email === email);
    if (!host) return;
    const weekly = host.weekly.map((r) => r.map((x) => [x[0], x[1]] as Range));
    weekly[day][index][part] = minutes;
    change(email, { weekly });
  }

  if (!open) {
    const team = view.team;
    return (
      <div className="mt-3 rounded-[var(--r-sm)] border border-line bg-white p-4" data-team-event={product.id}>
        {team ? (
          <>
            <p className="text-sm font-semibold text-ink">{`Team event · ${TEAM_MODE_NAMES[team.mode]} · ${team.hosts.length} ${team.hosts.length === 1 ? "host" : "hosts"}`}</p>
            <ul className="mt-2 space-y-1 text-sm text-ink-soft">
              {team.hosts.map((h) => {
                const s = view.sync[h.email];
                return (
                  <li key={h.email} className="break-words">
                    <span className="font-semibold text-ink">{h.email}</span>
                    {team.pick && h.label ? ` · buyers see "${h.label}"` : ""}
                    {` · ${h.tz} · up to ${h.dailyCap} a day`}
                    {s ? ` · ${SYNC_WORDS[s.state] ?? s.state}${s.source !== "none" ? `, ${ago(s.lastSuccess)}` : ""}` : ""}
                  </li>
                );
              })}
            </ul>
            {view.closed ? (
              <p className="notice notice-warn mt-3" role="status">
                {`Not on sale: your plan allows ${teamLimitWords(limits)}, and this one is beyond that. The oldest team events stay on.`}
              </p>
            ) : null}
            {team.pick ? <p className="mt-2 text-sm text-ink-soft">Buyers choose who they book with, or &quot;Any available&quot;.</p> : null}
            <p className="mt-2 text-sm text-ink-soft">Times come from each host&apos;s own hours and calendar; the call&apos;s own hours above are not used while it is a team event.</p>
          </>
        ) : (
          <p className="text-sm text-ink-soft">{`Book it with your team: round robin or everyone together. Your plan: ${teamLimitWords(limits)}.`}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm font-bold">
          {team || roomForNew ? (
            <button type="button" onClick={edit} disabled={limits.eventTypes === 0} className="inline-flex min-h-11 -my-2.5 items-center text-ink-soft underline underline-offset-4 transition hover:text-violet-deep">
              {team ? "Change the team" : "Make it a team event"}
            </button>
          ) : (
            <span className="text-ink-soft">{`Your plan allows ${limits.eventTypes} team event ${limits.eventTypes === 1 ? "type" : "types"}, and they are in use.`}</span>
          )}
          {team ? (
            <button type="button" disabled={busy} onClick={() => save(null, "It is an ordinary call again.")} className="inline-flex min-h-11 -my-2.5 items-center text-ink-soft underline underline-offset-4 transition hover:text-danger">
              Stop being a team event
            </button>
          ) : null}
          <a href={href("/studio/calendar")} className="inline-flex min-h-11 -my-2.5 items-center text-ink-soft underline underline-offset-4 transition hover:text-violet-deep">
            Your own calendar
          </a>
        </div>
        {error ? <p className="notice notice-error mt-3" role="alert">{error}</p> : null}
      </div>
    );
  }

  const chosen = new Set(hosts.map((h) => h.email));
  const full = hosts.length >= limits.hosts;
  return (
    <form
      className="mt-3 space-y-5 rounded-[var(--r-sm)] border border-line bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        // Names are sent only when buyers choose: a name nobody sees is not kept.
        const choose = pick && mode === "round_robin";
        void save({ mode, hosts: hosts.map(({ label, ...h }) => (choose ? { ...h, label: (label ?? "").trim() } : h)), ...(choose ? { pick: true } : {}) }, "Team saved.");
      }}
    >
      <fieldset>
        <legend className="field-label">How it is booked</legend>
        <div className="mt-2 grid gap-2">
          {TEAM_MODES.map((m) => (
            <label key={m} className={`flex cursor-pointer items-start gap-3 rounded-[12px] border px-3 py-3 ${mode === m ? "border-violet-brand bg-lilac/40" : "border-line bg-white"}`}>
              <input type="radio" name={`team-mode-${product.id}`} checked={mode === m} onChange={() => setMode(m)} className="mt-1 h-4 w-4 shrink-0" />
              <span>
                <span className="block text-sm font-semibold text-ink">{TEAM_MODE_NAMES[m]}</span>
                <span className="mt-0.5 block text-sm text-ink-soft">{TEAM_MODE_SUMMARIES[m]}</span>
              </span>
            </label>
          ))}
        </div>
        {mode === "round_robin" ? (
          <label className="mt-3 flex cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" checked={pick} onChange={(e) => setPick(e.target.checked)} className="mt-1 h-4 w-4 shrink-0" aria-describedby={`team-pick-help-${product.id}`} />
            <span>
              <span className="block font-semibold text-ink">Let buyers choose who they book with</span>
              <span id={`team-pick-help-${product.id}`} className="mt-0.5 block text-ink-soft">
                The booking page asks &quot;Who would you like to book with?&quot;, with each host&apos;s name and &quot;Any available&quot;. Give each host the name buyers see, below.
              </span>
            </span>
          </label>
        ) : null}
      </fieldset>

      <fieldset>
        <legend className="field-label">Hosts</legend>
        <p className="mt-1 text-sm text-ink-soft">{`Your plan: ${teamLimitWords(limits)}. Invite more people under Team.`}</p>
        <ul className="mt-2 grid gap-1.5 text-sm">
          {view.people.map((email) => (
            <li key={email}>
              <label className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0"
                  checked={chosen.has(email)}
                  disabled={!chosen.has(email) && full}
                  onChange={(e) => setHosts(e.target.checked ? [...hosts, hostFromCall(email, setup)] : hosts.filter((h) => h.email !== email))}
                />
                <span className="min-w-0 break-all">{`${email}${email === view.owner ? " (owner)" : ""}`}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      {hosts.map((host) => (
        <fieldset key={host.email} className="rounded-[12px] border border-line p-3">
          <legend className="px-1 text-sm font-semibold text-ink break-all">{host.email}</legend>
          {pick && mode === "round_robin" ? (
            <label className="mb-3 block">
              <span className="text-xs font-semibold text-ink-soft">Name buyers see (for example, Ana)</span>
              <input
                type="text"
                className="field mt-1 !min-h-0 !py-1.5"
                value={host.label ?? ""}
                maxLength={HOST_LABEL_MAX}
                autoComplete="off"
                required
                onChange={(e) => change(host.email, { label: e.target.value })}
              />
            </label>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-semibold text-ink-soft">Time zone</span>
              <select className="field mt-1 !min-h-0 !py-1.5" value={host.tz} onChange={(e) => change(host.email, { tz: e.target.value })}>
                {zones().map((z) => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-ink-soft">Team calls a day, at most</span>
              <select className="field mt-1 !min-h-0 !py-1.5" value={host.dailyCap} onChange={(e) => change(host.email, { dailyCap: Number(e.target.value) })}>
                {DAILY_CAPS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-ink-soft">Their gap between calls</span>
              <select className="field mt-1 !min-h-0 !py-1.5" value={host.bufferMinutes} onChange={(e) => change(host.email, { bufferMinutes: Number(e.target.value) })}>
                {BUFFERS.map((b) => (
                  <option key={b} value={b}>{b ? `${b} minutes` : "The call's own"}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-ink-soft">Their notice</span>
              <select className="field mt-1 !min-h-0 !py-1.5" value={host.noticeHours} onChange={(e) => change(host.email, { noticeHours: Number(e.target.value) })}>
                {NOTICE_CHOICES.map((h) => (
                  <option key={h} value={h}>{hoursLabel(h)}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-3 grid gap-2">
            {DAY_NAMES.map((name, day) => {
              const ranges = host.weekly[day] ?? [];
              return (
                <div key={name} className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="flex w-28 shrink-0 items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={ranges.length > 0}
                      onChange={(e) => {
                        const weekly = host.weekly.map((r) => r.map((x) => [x[0], x[1]] as Range));
                        weekly[day] = e.target.checked ? [[540, 1020]] : [];
                        change(host.email, { weekly });
                      }}
                    />
                    {name}
                  </label>
                  {ranges.map((range, index) => (
                    <span key={index} className="flex items-center gap-1.5">
                      <input type="time" step={300} aria-label={`${host.email}, ${name}, stretch ${index + 1}, from`} value={clock(range[0])} onChange={(e) => setRange(host.email, day, index, 0, e.target.value)} className="field !min-h-0 w-[7.5rem] !py-1.5" />
                      to
                      <input type="time" step={300} aria-label={`${host.email}, ${name}, stretch ${index + 1}, to`} value={clock(range[1] === 1440 ? 1439 : range[1])} onChange={(e) => setRange(host.email, day, index, 1, e.target.value)} className="field !min-h-0 w-[7.5rem] !py-1.5" />
                      {index > 0 ? (
                        <button
                          type="button"
                          aria-label={`Remove ${name}'s second stretch for ${host.email}`}
                          onClick={() => {
                            const weekly = host.weekly.map((r) => r.map((x) => [x[0], x[1]] as Range));
                            weekly[day] = weekly[day].slice(0, 1);
                            change(host.email, { weekly });
                          }}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none text-ink-mute transition hover:bg-white hover:text-danger"
                        >
                          &times;
                        </button>
                      ) : null}
                    </span>
                  ))}
                  {ranges.length > 0 && ranges.length < MAX_RANGES_PER_DAY ? (
                    <button
                      type="button"
                      onClick={() => {
                        const weekly = host.weekly.map((r) => r.map((x) => [x[0], x[1]] as Range));
                        const end = weekly[day][0][1];
                        weekly[day].push([Math.min(end + 60, 1380), Math.min(end + 180, 1440)]);
                        change(host.email, { weekly });
                      }}
                      className="text-sm font-semibold text-violet-deep underline underline-offset-4"
                    >
                      Add a second stretch
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}

      <p className="rounded-[10px] bg-paper px-3 py-2 text-sm text-ink-soft">
        {`${mode === "collective" ? "Only times every host is free are offered." : "Each booking goes to a free host, sharing them out evenly."} A host whose own calendar cannot be read, or was last read more than 20 minutes ago, is left out until it can be, and nobody is ever booked twice for the same time, on this store or another. Each host sets their calendar under Your calendar${view.googleSync ? ", with Google Calendar two-way sync" : " (Google Calendar two-way sync is not switched on yet: they can add a private iCal address)"}.`}
      </p>

      {error ? <p className="notice notice-error" role="alert">{error}</p> : null}

      <div className="flex flex-wrap gap-2">
        <button type="submit" aria-busy={busy} disabled={busy || hosts.length === 0} className="btn btn-primary">
          {busy ? "Saving…" : "Save the team"}
        </button>
        <button type="button" onClick={() => { setOpen(false); setError(null); }} className="btn btn-ghost">
          Cancel
        </button>
      </div>
    </form>
  );
}
