"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { MAX_POST_TEXT, MAX_POST_TITLE } from "@/lib/community-text";
import { MAX_AHEAD_DAYS, MAX_SCHEDULED_POSTS, MIN_LEAD_SECONDS, SCHEDULE_PROBLEMS } from "@/lib/community-schedule-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

/** One scheduled post, as the studio shows it. Its time and its state are put in words by the server. */
export type StudioScheduled = {
  id: string;
  space: string;
  spaceName: string;
  title: string;
  text: string;
  kind: "post" | "announcement";
  email: boolean;
  date: string;
  time: string;
  tz: string;
  /** "Goes up Tuesday, January 15, 2030 at 9:30 AM EST", or "Set for …" once late or done. */
  when: string;
  /** Waiting: it can still be canceled. */
  waiting: boolean;
  /** Waiting and not yet within the lead before its time: it can still be changed. */
  changeable: boolean;
  /** Done with or held up, so it can be cleared from the list. */
  clearable: boolean;
  /** Where it stands, in one sentence. */
  state: string;
  /** Its page once posted. */
  href: string;
};

type Space = { id: string; name: string };
type Draft = { space: string; title: string; text: string; kind: "post" | "announcement"; email: boolean; date: string; time: string; tz: string };
type Answer = { ok?: boolean; error?: string; message?: string };

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  ...SCHEDULE_PROBLEMS,
  too_many: `Your community can keep ${MAX_SCHEDULED_POSTS} scheduled posts at once. Clear the ones already posted, or cancel one.`,
  busy: "It is being posted right now, so it can no longer be changed. Look for it in your community.",
  done: "It has already been posted or stopped, so it can no longer be changed. Reload the page.",
  gone: "That scheduled post is not there anymore. Reload the page.",
  unknown: "That scheduled post is not there anymore. Reload the page.",
  owner_only: "Only the store's owner can post as the creator.",
  store_full: "Your store's data room is full. Delete old posts or drafts you no longer need.",
  used: "Your store has used this month's studio requests, so nothing was scheduled.",
  unknown_count: "Your store's requests could not be counted just now, so nothing was scheduled. Try again in a minute.",
  resting: "Your store cannot take more work this month, so nothing was scheduled.",
  not_set_up: "Set the community up first.",
  invalid: "That could not be read. Nothing was changed.",
  server_error: "Something went wrong on our side. Nothing was changed. Try again in a moment.",
};

async function send(payload: Record<string, unknown>): Promise<Answer> {
  try {
    const response = await fetch("/api/store/community/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Answer;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

function zones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list && list.length) return list;
  } catch {}
  return ["UTC"];
}

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function tomorrow(): string {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const small = "inline-flex min-h-11 items-center text-sm font-semibold text-ink-soft underline underline-offset-4 transition hover:text-violet-deep disabled:no-underline disabled:opacity-40";

/** 293 [SQ4]: posts and announcements written now and put up in the community later. For the store's owner. */
export function CommunitySchedule({
  posts,
  spaces,
  canEmail,
  reach,
  handle,
}: {
  posts: StudioScheduled[] | null;
  spaces: Space[];
  /** Whether this store's plan sends community emails now (lib/community-mail.ts). */
  canEmail: boolean;
  /** How many members asked for announcement emails, today. */
  reach: number;
  handle: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ where: string; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const waiting = posts?.filter((p) => p.waiting).length ?? 0;

  async function run(where: string, payload: Record<string, unknown>, done: string): Promise<boolean> {
    setBusy(where);
    setError(null);
    const answer = await send(payload);
    setBusy(null);
    if (!answer.ok) {
      setError({ where, text: answer.message || MESSAGES[answer.error ?? ""] || MESSAGES.server_error });
      return false;
    }
    toast(done);
    router.refresh();
    return true;
  }

  const problem = (where: string) =>
    error?.where === where ? (
      <p className="notice notice-error mt-4" role="alert">{error.text}</p>
    ) : null;

  return (
    <section id="scheduled" className="card mt-8 scroll-mt-24 p-6 sm:p-8" aria-labelledby="cm-scheduled-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="cm-scheduled-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Scheduled posts</h2>
        <span className={`tag ${waiting ? "tag-brand" : ""}`}>{waiting ? `${waiting} waiting` : "None waiting"}</span>
      </div>
      <p className="mt-2 max-w-2xl text-ink-soft">
        {`Write a post or an announcement now, and pick the day and time it goes up in your community. Until then you can change it or cancel it. At its time it is posted as yours, under the community's rules as they are then. A scheduled post has words only: for a picture or a poll, post it now from the community page. It goes up within five minutes of its time.`}
      </p>

      {posts === null ? (
        <p className="notice notice-error mt-4" role="alert">Your scheduled posts could not be read just now. Reload the page.</p>
      ) : posts.length ? (
        <ul className="mt-5 space-y-3">
          {posts.map((p) => (
            <li key={p.id} className="rounded-[var(--r-md)] bg-paper p-4 ring-1 ring-line">
              <p className="font-semibold text-ink">{p.title || p.text.slice(0, 80)}</p>
              <p className="mt-1 text-sm text-ink-soft">
                {`${p.kind === "announcement" ? (p.email ? "Announcement, emailed to members who asked" : "Announcement") : "Post"} in ${p.spaceName}. ${p.when}.`}
              </p>
              <p className="mt-1 text-sm text-ink">{p.state}</p>
              {p.waiting && !p.changeable ? <p className="mt-1 text-sm text-ink-soft">{MESSAGES.too_close}</p> : null}
              {p.href ? (
                <p className="mt-1 text-sm">
                  <a href={p.href} className="font-semibold underline underline-offset-4">{`Open the post${p.title ? `: ${p.title}` : ""}`}</a>
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-x-5">
                {p.changeable ? (
                  <button type="button" className={small} disabled={busy !== null} onClick={() => { setEditing(editing === p.id ? null : p.id); setAsking(null); }} aria-expanded={editing === p.id}>
                    {editing === p.id ? "Close the editor" : `Change ${p.title ? `"${p.title}"` : "this post"}`}
                  </button>
                ) : null}
                {(p.waiting || p.clearable) && asking !== p.id ? (
                  <button type="button" className={small} disabled={busy !== null} onClick={() => { setAsking(p.id); setEditing(null); }}>
                    {p.waiting ? `Cancel ${p.title ? `"${p.title}"` : "this post"}` : `Clear ${p.title ? `"${p.title}"` : "this post"} from the list`}
                  </button>
                ) : null}
              </div>
              {asking === p.id ? (
                <div className="mt-3 rounded-[var(--r-sm)] bg-white p-3 ring-1 ring-line" role="group" aria-label="Confirm">
                  <p className="text-sm text-ink">{p.waiting ? "Cancel it? Its words are deleted and it will not be posted." : "Clear it from this list? A post already up stays in your community."}</p>
                  <div className="mt-2 flex flex-wrap gap-3">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy !== null}
                      onClick={async () => {
                        if (await run(`x-${p.id}`, { action: "cancel", id: p.id }, p.waiting ? "Canceled. It will not be posted." : "Cleared from the list.")) setAsking(null);
                      }}
                    >
                      {busy === `x-${p.id}` ? "Working…" : p.waiting ? "Yes, cancel it" : "Yes, clear it"}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setAsking(null)}>{p.waiting ? "Keep it" : "Keep it listed"}</button>
                  </div>
                </div>
              ) : null}
              {problem(`x-${p.id}`)}
              {editing === p.id ? (
                <ScheduleForm
                  key={p.id}
                  where={`e-${p.id}`}
                  start={{ space: p.space, title: p.title, text: p.text, kind: p.kind, email: p.email, date: p.date, time: p.time, tz: p.tz }}
                  spaces={spaces}
                  canEmail={canEmail}
                  reach={reach}
                  busy={busy}
                  label="Save the changes"
                  onClose={() => setEditing(null)}
                  onSave={async (draft) => {
                    if (await run(`e-${p.id}`, { action: "edit", id: p.id, ...draft }, "Saved. It goes up at its new time.")) setEditing(null);
                  }}
                  problem={problem(`e-${p.id}`)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-ink-soft">Nothing scheduled yet.</p>
      )}

      {posts !== null && !adding ? (
        <p className="mt-5">
          <button type="button" className="btn btn-primary" disabled={!spaces.length} onClick={() => { setAdding(true); setEditing(null); setAsking(null); }}>
            Schedule a post
          </button>
          {!spaces.length ? <span className="ml-3 text-sm text-ink-soft">Add a space to your community first.</span> : null}
        </p>
      ) : null}
      {adding ? (
        <ScheduleForm
          where="new"
          start={null}
          spaces={spaces}
          canEmail={canEmail}
          reach={reach}
          busy={busy}
          label="Schedule it"
          onClose={() => setAdding(false)}
          onSave={async (draft) => {
            if (await run("new", { action: "add", ...draft }, "Scheduled. You can change it or cancel it until its time.")) setAdding(false);
          }}
          problem={problem("new")}
        />
      ) : null}
      <p className="mt-4 text-sm text-ink-soft">
        <a href={`/@${handle}/community`} className="font-semibold underline underline-offset-4">Open your community to post now</a>
      </p>
    </section>
  );
}

function ScheduleForm({
  where,
  start,
  spaces,
  canEmail,
  reach,
  busy,
  label,
  onClose,
  onSave,
  problem,
}: {
  where: string;
  start: Draft | null;
  spaces: Space[];
  canEmail: boolean;
  reach: number;
  busy: string | null;
  label: string;
  onClose: () => void;
  onSave: (draft: Draft) => void;
  problem: React.ReactNode;
}) {
  const [zoneList] = useState(zones);
  const [draft, setDraft] = useState<Draft>(
    () => start ?? { space: spaces[0]?.id ?? "", title: "", text: "", kind: "post", email: false, date: tomorrow(), time: "09:00", tz: localZone() },
  );
  const set = (change: Partial<Draft>) => setDraft((d) => ({ ...d, ...change }));
  const id = (name: string) => `sch-${where}-${name}`;
  const zoneOptions = zoneList.includes(draft.tz) ? zoneList : [draft.tz, ...zoneList];

  return (
    <form
      className="mt-5 space-y-4 rounded-[var(--r-md)] bg-paper p-4 ring-1 ring-line sm:p-5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...draft, email: draft.kind === "announcement" && canEmail && draft.email });
      }}
    >
      <p className="font-semibold text-ink">{start ? "Change the scheduled post" : "A new scheduled post"}</p>
      <fieldset>
        <legend className="field-label">What it is</legend>
        {(["post", "announcement"] as const).map((kind) => (
          <label key={kind} className="mt-1 flex min-h-[44px] cursor-pointer items-start gap-3 rounded-[var(--r-sm)] px-2 py-2 hover:bg-white">
            <input type="radio" name={id("kind")} className="mt-1 h-5 w-5 shrink-0" checked={draft.kind === kind} onChange={() => set({ kind, email: kind === "announcement" ? draft.email : false })} />
            <span className="min-w-0">
              <span className="block font-semibold text-ink">{kind === "post" ? "A post" : "An announcement"}</span>
              <span className="block text-sm text-ink-soft">{kind === "post" ? "Shows in the feed like any of your posts." : "Shows in the feed marked as an announcement, and can also be emailed."}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {draft.kind === "announcement" ? (
        canEmail ? (
          <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-[var(--r-sm)] px-2 py-2 hover:bg-white">
            <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={draft.email} onChange={(e) => set({ email: e.target.checked })} aria-describedby={id("email-help")} />
            <span className="min-w-0">
              <span className="block font-semibold text-ink">Also email it when it goes up</span>
              <span id={id("email-help")} className="block text-sm text-ink-soft">
                {`To the members who asked for announcement emails then (${reach.toLocaleString("en-US")} today), from your monthly emails, checked at that time.`}
              </span>
            </span>
          </label>
        ) : (
          <p className="text-sm text-ink-soft">Your plan does not send community emails right now, so it is posted without an email.</p>
        )
      ) : null}
      <div>
        <label htmlFor={id("space")} className="field-label">Space</label>
        <select id={id("space")} className="field mt-1" value={draft.space} onChange={(e) => set({ space: e.target.value })}>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={id("title")} className="field-label">Title (optional)</label>
        <input id={id("title")} className="field mt-1" maxLength={MAX_POST_TITLE} value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder="Week two starts today" />
      </div>
      <div>
        <label htmlFor={id("text")} className="field-label">What it says</label>
        <textarea id={id("text")} className="field mt-1 min-h-[7rem]" required maxLength={MAX_POST_TEXT} value={draft.text} onChange={(e) => set({ text: e.target.value })} placeholder="Good morning! This week we cover pricing. Start with lesson 4, then share your first number below." />
      </div>
      <fieldset>
        <legend className="field-label">When it goes up</legend>
        <p className="mt-1 text-sm text-ink-soft">{`At least ${MIN_LEAD_SECONDS / 60} minutes from now, and within ${MAX_AHEAD_DAYS} days.`}</p>
        <div className="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="col-span-2 block">
            <span className="text-xs font-semibold text-ink-soft">Date</span>
            <input type="date" required value={draft.date} onChange={(e) => set({ date: e.target.value })} className="field mt-1 !min-h-0 !py-1.5" />
          </label>
          <label className="col-span-2 block sm:col-span-1">
            <span className="text-xs font-semibold text-ink-soft">Time</span>
            <input type="time" step={300} required value={draft.time} onChange={(e) => set({ time: e.target.value })} className="field mt-1 !min-h-0 !py-1.5" />
          </label>
          <label className="col-span-2 block sm:col-span-4">
            <span className="text-xs font-semibold text-ink-soft">Time zone</span>
            <select value={draft.tz} onChange={(e) => set({ tz: e.target.value })} className="field mt-1 !min-h-0 !py-1.5 !pl-3">
              {zoneOptions.map((z) => (
                <option key={z} value={z}>{z.replace(/_/g, " ")}</option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>
      {problem}
      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn btn-primary" disabled={busy !== null}>{busy === where ? "Saving…" : label}</button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close without saving</button>
      </div>
    </form>
  );
}
