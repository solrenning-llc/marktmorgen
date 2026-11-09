"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type ChatRefusal, MAX_CHAT_TEXT } from "@/lib/community-chat-rules";
import { AWAY_AFTER_MS, IDLE_MS, LIVE_MS, type Pace, askEvery, paceFor } from "@/lib/chat-pace";
import type { RoomWords } from "@/lib/buyer-words/community";

type Message = { i: number; a: string; text: string; at: number; n?: string };
/** Leave to ask the shared route, as the server hands it (lib/chat-grant.ts). */
type Leave = { pass: string; ms: number; live: boolean };

const REFUSALS = new Set<string>([
  "off", "empty", "links", "slow", "hourly", "creatorOnly", "muted", "full", "name", "out", "resting", "unknown",
]);
const isRefusal = (value: unknown): value is ChatRefusal => typeof value === "string" && REFUSALS.has(value);

/**
 * The room, as it is read and written.
 *
 * It asks what is new every few seconds while people are talking, twice a
 * minute while the room is quiet, and not at all while the tab is in the
 * background or the page has not been touched for a while
 * (lib/chat-pace.ts). There is no socket held open, and the page says as
 * much rather than claiming a word it has not earned.
 *
 * What it asks every few seconds is not the route that knows who it is. It
 * holds leave to ask a small shared one for ten minutes at a time
 * (lib/chat-grant.ts), and goes back to the route that knows it only for
 * the next ten minutes, or for the faster pace when a quiet room starts
 * talking. A store with no leave to give has a button instead.
 *
 * Three things it does that matter more than they look:
 *
 *   - It scrolls to the newest message only when the reader was already at the
 *     bottom. Dragging somebody away from what they are reading because
 *     somebody else typed is the commonest thing wrong with a chat room.
 *   - It says what the server said. A cooldown, a muted member, a web address
 *     in a room that does not take them: each is shown in its own words rather
 *     than as "something went wrong".
 *   - It sends with the box emptied and puts the words back if the send fails,
 *     so nothing anybody typed is lost to a dropped connection.
 */
export function CommunityRoom({
  handle,
  room,
  first,
  names: firstNames,
  cursor: firstCursor,
  me,
  creator,
  creatorName,
  canWrite,
  owner,
  creatorOnly,
  slow,
  links,
  leave,
  resting: firstResting,
  quiet,
  words: t,
  namesUnread: firstNamesUnread = false,
  namesUnreadText = "",
}: {
  handle: string;
  /** The community's id: what the shared route is asked about. */
  room: string;
  first: Message[];
  names: Record<string, string>;
  cursor: number;
  /** This reader's own key, so their messages sit on their side. */
  me: string;
  /** The key the creator's messages are under, and the name they are shown with. */
  creator: string;
  creatorName: string;
  canWrite: boolean;
  owner: boolean;
  creatorOnly: boolean;
  slow: number;
  links: boolean;
  /** Leave to ask for the next ten minutes, or null when there is none. */
  leave: Leave | null;
  /** The store has no leave to give: the room is read by asking for it. */
  resting: boolean;
  /** Seconds since the room was last spoken in when the page was drawn; -1 for a room nobody has spoken in. */
  quiet: number;
  /** Everything it says, in the store's language (lib/buyer-words/community.ts). */
  words: RoomWords;
  /** Whether some names could not be read when the page was drawn (rules 24 and 30). */
  namesUnread?: boolean;
  /** What it says then, in the store's language (lib/buyer-words/community-names-unread.ts). */
  namesUnreadText?: string;
}) {
  const [messages, setMessages] = useState<Message[]>(first);
  const [names, setNames] = useState<Record<string, string>>(firstNames);
  // Some names did not read, here or on a later look: those people show as "A member", and the room says so.
  const [namesLost, setNamesLost] = useState(firstNamesUnread);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [resting, setResting] = useState(firstResting);
  const [away, setAway] = useState(false);
  const [checking, setChecking] = useState(false);
  // Emptying the room asks twice rather than opening a browser dialog: a
  // dialog stops everything on the page until it is answered, and this is a
  // thing done in a hurry.
  const [emptying, setEmptying] = useState(false);
  const cursor = useRef(firstCursor);
  const list = useRef<HTMLUListElement>(null);
  const atBottom = useRef(true);
  // What the pace is worked out from, kept by this page's own clock: when
  // the room was last spoken in, when the reader last touched the page, and
  // the leave held. Set when the page starts, never while it is drawn.
  const said = useRef(0);
  const touched = useRef(0);
  const held = useRef<{ pass: string; until: number; live: boolean } | null>(null);
  const restingNow = useRef(firstResting);
  // A faster pace that was asked for and not given is not asked for again
  // until something more has been said.
  const refusedAt = useRef(-1);
  // Asks now instead of at the next turn: what sending a message does, so
  // that an answer to it is not waited on at a quiet room's pace.
  const kick = useRef<() => void>(() => {});

  const take = useCallback(
    (found: Message[], given?: Record<string, string>) => {
      if (!found.length) return;
      cursor.current = Math.max(cursor.current, found[found.length - 1].i);
      said.current = Date.now();
      const named: Record<string, string> = { ...given };
      for (const m of found) {
        if (named[m.a]) continue;
        if (m.a === creator) named[m.a] = creatorName;
        else if (m.n) named[m.a] = m.n;
      }
      setNames((kept) => ({ ...kept, ...named }));
      setMessages((kept) => {
        const known = new Set(kept.map((m) => m.i));
        const added = found.filter((m) => !known.has(m.i));
        return added.length ? [...kept, ...added].slice(-500) : kept;
      });
    },
    [creator, creatorName],
  );

  /**
   * Asks the route that knows who this is: for what is new, and, when
   * `want` is given, for leave to ask the shared one at that pace.
   */
  const look = useCallback(
    async (want?: "live" | "idle") => {
      try {
        const response = await fetch(
          `/api/store/community/chat?handle=${encodeURIComponent(handle)}&since=${cursor.current}${want ? `&grant=${want}` : ""}`,
          { credentials: "same-origin" },
        );
        const data = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          messages?: Message[];
          names?: Record<string, string>;
          namesUnread?: boolean;
          grant?: Leave | null;
          resting?: boolean;
        };
        if (!data.ok) return;
        take(data.messages ?? [], data.names);
        if (data.namesUnread === true) setNamesLost(true);
        if (want) {
          held.current = data.grant ? { pass: data.grant.pass, until: Date.now() + data.grant.ms, live: data.grant.live } : null;
          restingNow.current = data.resting === true;
          setResting(restingNow.current);
          if (want === "live" && !data.grant?.live) refusedAt.current = cursor.current;
        }
      } catch {
        // A look that failed is a look; the next one is a few seconds away and
        // there is nothing useful to say about one dropped request.
      }
    },
    [handle, take],
  );

  /** Asks the shared route what came after the last message held. False when the pass no longer opens it. */
  const news = useCallback(
    async (pass: string, idle: boolean): Promise<boolean> => {
      try {
        const response = await fetch(`/api/store/community/chat/new?c=${room}&p=${pass}&s=${cursor.current}${idle ? "&i=1" : ""}`, {
          credentials: "omit",
        });
        if (response.status === 403) return false;
        const data = (await response.json().catch(() => ({}))) as { ok?: boolean; messages?: Message[] };
        if (data.ok) take(data.messages ?? []);
      } catch {
        // As above: the next look is not far off.
      }
      return true;
    },
    [room, take],
  );

  useEffect(() => {
    const started = Date.now();
    said.current = quiet >= 0 ? started - quiet * 1000 : 0;
    touched.current = started;
    held.current = leave ? { pass: leave.pass, until: started + leave.ms, live: leave.live } : null;
    let timer: number | undefined;
    let busy = false;
    let over = false;

    const paceNow = (): Pace => {
      const now = Date.now();
      return paceFor(said.current ? now - said.current : Number.POSITIVE_INFINITY, now - touched.current);
    };

    const once = async (): Promise<number> => {
      // Nothing is asked for while nobody is looking, or after the reader
      // has walked away from the page.
      if (document.hidden) return IDLE_MS;
      const pace = paceNow();
      setAway(pace === "stopped");
      if (pace === "stopped" || restingNow.current) return IDLE_MS;
      const want = pace === "live" ? "live" : "idle";
      const leaveNow = held.current;
      if (!leaveNow) {
        // No leave could be made on this deployment: asked by name, at the new pace.
        await look();
        return askEvery(pace);
      }
      if (Date.now() >= leaveNow.until - 3_000) await look(want);
      else if (want === "live" && !leaveNow.live && refusedAt.current !== cursor.current) await look("live");
      else if (!(await news(leaveNow.pass, !(want === "live" && leaveNow.live)))) await look(want);
      return paceNow() === "live" && held.current?.live ? LIVE_MS : IDLE_MS;
    };

    const tick = async () => {
      if (over || busy) return;
      busy = true;
      let wait = IDLE_MS;
      try {
        wait = await once();
      } finally {
        busy = false;
      }
      if (over) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void tick(), wait);
    };

    kick.current = () => void tick();
    timer = window.setTimeout(() => void tick(), leave?.live ? LIVE_MS : IDLE_MS);
    // Coming back, to the tab or to the page, asks right away rather than waiting.
    const onShow = () => {
      if (!document.hidden) void tick();
    };
    const onTouch = () => {
      const was = Date.now() - touched.current;
      touched.current = Date.now();
      if (was >= AWAY_AFTER_MS) void tick();
    };
    document.addEventListener("visibilitychange", onShow);
    const touches = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
    for (const name of touches) window.addEventListener(name, onTouch, { passive: true });
    return () => {
      over = true;
      kick.current = () => {};
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShow);
      for (const name of touches) window.removeEventListener(name, onTouch);
    };
  }, [look, news, leave, quiet]);

  /** The button of a room that is not asking by itself: asks once, and for leave again in case there is some now. */
  async function check() {
    if (checking) return;
    setChecking(true);
    try {
      await look("idle");
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    const box = list.current;
    if (box && atBottom.current) box.scrollTop = box.scrollHeight;
  }, [messages]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const words = text.trim();
    if (!words || sending) return;
    setSending(true);
    setError(null);
    setText("");
    try {
      const response = await fetch("/api/store/community/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, action: "say", text: words }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        wait?: number;
        message?: Message;
        name?: string;
      };
      if (!data.ok || !data.message) {
        // Back in the box: nothing anybody typed is lost to a refusal.
        setText(words);
        // Every reason has its own sentence, in one place beside the refusals
        // themselves (lib/community-chat.ts). Anything unrecognised is the
        // honest generic one rather than a guess.
        const reason = isRefusal(data.error) ? data.error : "unknown";
        setError(
          reason === "slow"
            ? t.slowRefusal.replace("{n}", String(slow)).replace("{more}", String(data.wait ?? slow))
            : t.refusals[reason] ?? t.refusals.unknown,
        );
        return;
      }
      // Not the cursor: somebody else may have spoken just before, and their
      // message is still to be fetched. take() skips this one when it comes.
      said.current = Date.now();
      touched.current = Date.now();
      refusedAt.current = -1;
      kick.current();
      if (data.name) setNames((kept) => ({ ...kept, [data.message!.a]: data.name! }));
      setMessages((kept) => (kept.some((m) => m.i === data.message!.i) ? kept : [...kept, data.message!]));
      atBottom.current = true;
    } catch {
      setText(words);
      setError(t.refusals.unknown);
    } finally {
      setSending(false);
    }
  }

  /** Takes one message out of the room. The creator's, on anything in it. */
  async function remove(i: number) {
    setError(null);
    try {
      const response = await fetch("/api/store/community/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, action: "unsay", number: i }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean };
      if (!data.ok) {
        setError(t.removeFailed);
        return;
      }
      setMessages((held) => held.filter((m) => m.i !== i));
    } catch {
      setError(t.removeFailed);
    }
  }

  /** Empties it. What a creator does after a bad night. */
  async function empty() {
    setError(null);
    try {
      const response = await fetch("/api/store/community/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, action: "clear" }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean };
      if (!data.ok) {
        setError(t.emptyFailed);
        return;
      }
      setMessages([]);
      setEmptying(false);
    } catch {
      setError(t.emptyFailed);
    }
  }

  const when = (at: number) =>
    new Date(at * 1000).toLocaleTimeString(t.locale, { hour: "numeric", minute: "2-digit" });

  return (
    <div className="mt-5">
      {namesLost && namesUnreadText ? <p className="cm-flash cm-flash-warn mb-3" role="status">{namesUnreadText}</p> : null}
      <ul
        ref={list}
        className="cm-room"
        onScroll={(e) => {
          const box = e.currentTarget;
          atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
        }}
      >
        {messages.length === 0 ? (
          <li className="st-muted p-4 text-center text-sm">{t.nothingSaid}</li>
        ) : (
          messages.map((message) => {
            const mine = message.a === me;
            return (
              <li key={message.i} className={`flex ${mine ? "justify-end" : "justify-start"} px-3 py-1`}>
                <div className={`cm-dm-bubble ${mine ? "cm-dm-mine" : ""}`}>
                  {!mine ? (
                    <p className="text-xs font-bold">{names[message.a] ?? t.aMember}</p>
                  ) : null}
                  <p className="cm-text text-[0.9375rem]">{message.text}</p>
                  <p className="st-muted mt-0.5 flex items-center justify-end gap-2 text-[0.6875rem] font-semibold">
                    {owner ? (
                      <button
                        type="button"
                        className="cm-quiet-link cm-mini cm-danger"
                        onClick={() => void remove(message.i)}
                      >
                        {t.remove}
                      </button>
                    ) : null}
                    <span>{when(message.at)}</span>
                  </p>
                </div>
              </li>
            );
          })
        )}
      </ul>

      {canWrite && (!creatorOnly || owner) ? (
        <form onSubmit={send} className="mt-3">
          <label htmlFor="room-text" className="sr-only">{t.sayLabel}</label>
          <div className="flex gap-2">
            <input
              id="room-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={MAX_CHAT_TEXT}
              placeholder={t.sayPlaceholder}
              className="st-field min-w-0 flex-1 !min-h-[44px] !py-2"
              autoComplete="off"
            />
            <button type="submit" className="btn st-btn" disabled={sending || !text.trim()}>{t.send}</button>
          </div>
        </form>
      ) : (
        <p className="st-muted mt-3 text-sm">
          {creatorOnly && !owner ? t.refusals.creatorOnly : t.refusals.muted}
        </p>
      )}

      {error ? <p className="cm-flash cm-flash-warn mt-3" role="status">{error}</p> : null}

      {owner && messages.length ? (
        <p className="mt-3">
          {emptying ? (
            <span className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">{t.emptyConfirm}</span>
              <button type="button" className="cm-pill cm-danger" onClick={() => void empty()}>{t.yesEmpty}</button>
              <button type="button" className="cm-quiet-link cm-mini text-xs font-semibold" onClick={() => setEmptying(false)}>
                {t.keepIt}
              </button>
            </span>
          ) : (
            <button type="button" className="cm-quiet-link cm-mini text-xs font-semibold" onClick={() => setEmptying(true)}>
              {t.emptyRoom}
            </button>
          )}
        </p>
      ) : null}

      {resting ? (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <button type="button" className="cm-pill" onClick={() => void check()} disabled={checking}>
            {checking ? t.checking : t.checkNew}
          </button>
          <span className="st-muted">{t.notChecking}</span>
        </p>
      ) : away ? (
        <p className="st-muted mt-3 text-sm" role="status">
          {t.paused}
        </p>
      ) : null}

      <p className="st-muted mt-3 text-xs">
        {[
          resting
            ? t.restingNote
            : t.paceNote,
          slow > 0 ? t.slowNote.replace("{n}", String(slow)) : "",
          links ? "" : t.noLinksNote,
          t.keptNote,
        ]
          .filter(Boolean)
          .join(" ")}
      </p>
    </div>
  );
}
