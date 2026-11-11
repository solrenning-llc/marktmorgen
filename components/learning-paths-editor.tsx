"use client";

import { useState } from "react";
import { MAX_PATHS, MAX_PATH_COURSES, MAX_PATH_NAME, MIN_PATH_COURSES, type PathOrder, type StoredPath } from "@/lib/learning-path-rules";

/**
 * The studio's editor of a store's learning paths (249 [ST2], unit 3): each
 * path a group with its name, its order and its courses, moved with buttons
 * (never only by dragging, WCAG 2.5.7), and one save for the whole list
 * (app/api/store/learning-paths). A path removed can be put back until the
 * page is left; nothing is kept until the save says so. `initial` null: the
 * kept list could not be read, so no editor is drawn over it (rule 24).
 */

type Draft = { id?: string; name: string; courses: string[]; order: PathOrder };
type Course = { id: string; title: string };

const button = "btn btn-secondary btn-sm min-h-11";

export function LearningPathsEditor({ initial, courses }: { initial: StoredPath[] | null; courses: Course[] }) {
  const [paths, setPaths] = useState<Draft[]>(() => (initial ?? []).map((p) => ({ id: p.id, name: p.name, courses: [...p.courses], order: p.order })));
  const [removed, setRemoved] = useState<{ path: Draft; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  if (initial === null) {
    return <p className="notice notice-warn">Your paths could not be read just now. Nothing is shown here so nothing is saved over them; reload the page in a moment.</p>;
  }

  const titles = new Map(courses.map((c) => [c.id, c.title]));
  const enough = courses.length >= MIN_PATH_COURSES;
  const change = (i: number, next: Partial<Draft>) => {
    setSaid(null);
    setPaths((list) => list.map((p, j) => (j === i ? { ...p, ...next } : p)));
  };
  const move = (i: number, k: number, by: -1 | 1) => {
    const list = [...paths[i].courses];
    [list[k], list[k + by]] = [list[k + by], list[k]];
    change(i, { courses: list });
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaid(null);
    try {
      const response = await fetch("/api/store/learning-paths", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }) });
      const reply = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; message?: string; paths?: StoredPath[] } | null;
      if (response.ok && reply?.ok && Array.isArray(reply.paths)) {
        setPaths(reply.paths.map((p) => ({ id: p.id, name: p.name, courses: [...p.courses], order: p.order })));
        setRemoved(null);
        setSaid({ ok: true, text: reply.paths.length === 1 ? "Saved: 1 path." : `Saved: ${reply.paths.length} paths.` });
      } else if (reply?.error === "busy") {
        setSaid({ ok: false, text: "Your paths are being saved from another window. Wait a moment, reload, and try again. Nothing was saved from here." });
      } else if (reply?.message) {
        setSaid({ ok: false, text: reply.message });
      } else {
        setSaid({ ok: false, text: "We could not confirm the save, so it is not shown as saved. Try again in a moment." });
      }
    } catch {
      setSaid({ ok: false, text: "We could not confirm the save, so it is not shown as saved. Try again in a moment." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-6" noValidate>
      {!enough ? (
        <p className="notice">{`A path puts ${MIN_PATH_COURSES} or more of your courses in order. Make at least two courses first; then come back here.`}</p>
      ) : null}
      {paths.length === 0 && enough ? <p className="text-ink-soft">You have no paths yet.</p> : null}
      {paths.map((path, i) => {
        const left = courses.filter((c) => !path.courses.includes(c.id));
        return (
          <fieldset key={path.id ?? `new-${i}`} className="card space-y-4 p-5 sm:p-6">
            <legend className="px-1 text-lg font-semibold text-ink">{`Path ${i + 1}`}</legend>
            <div>
              <label htmlFor={`path-${i}-name`} className="field-label block">Name</label>
              <input id={`path-${i}-name`} className="field mt-1" value={path.name} maxLength={MAX_PATH_NAME} onChange={(event) => change(i, { name: event.target.value })} />
            </div>
            <div role="radiogroup" aria-labelledby={`path-${i}-order`}>
              <p id={`path-${i}-order`} className="field-label">How the courses open</p>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="radio" name={`path-${i}-order`} className="h-5 w-5" checked={path.order === "sequence"} onChange={() => change(i, { order: "sequence" })} />
                One after another: each course opens when the one before it is finished.
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="radio" name={`path-${i}-order`} className="h-5 w-5" checked={path.order === "free"} onChange={() => change(i, { order: "free" })} />
                In any order: every course the student has is open.
              </label>
            </div>
            <div>
              <p className="field-label">{`Courses, in order (${MIN_PATH_COURSES} to ${MAX_PATH_COURSES})`}</p>
              <ol className="mt-2 space-y-2">
                {path.courses.map((id, k) => {
                  const title = titles.get(id) ?? "A course no longer in your store";
                  return (
                    <li key={id} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{`${k + 1}. ${title}`}</span>
                      <button type="button" className={button} aria-label={`Move up: ${title}`} disabled={k === 0} onClick={() => move(i, k, -1)}>Move up</button>
                      <button type="button" className={button} aria-label={`Move down: ${title}`} disabled={k === path.courses.length - 1} onClick={() => move(i, k, 1)}>Move down</button>
                      <button type="button" className={button} aria-label={`Take out: ${title}`} onClick={() => change(i, { courses: path.courses.filter((c) => c !== id) })}>Take out</button>
                    </li>
                  );
                })}
              </ol>
              {left.length > 0 && path.courses.length < MAX_PATH_COURSES ? (
                <div className="mt-3">
                  <label htmlFor={`path-${i}-add`} className="field-label block">Add a course</label>
                  <select
                    id={`path-${i}-add`}
                    className="field mt-1"
                    value=""
                    onChange={(event) => {
                      if (event.target.value) change(i, { courses: [...path.courses, event.target.value] });
                    }}
                  >
                    <option value="">Choose a course…</option>
                    {left.map((c) => (
                      <option key={c.id} value={c.id}>{c.title}</option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className={button}
              onClick={() => {
                setSaid(null);
                setRemoved({ path, at: i });
                setPaths((list) => list.filter((_, j) => j !== i));
              }}
            >
              {`Remove path ${i + 1}`}
            </button>
          </fieldset>
        );
      })}
      {removed ? (
        <p className="flex flex-wrap items-center gap-3 text-sm">
          <span>{`Removed "${removed.path.name || "a path"}". It is gone once you save.`}</span>
          <button
            type="button"
            className={button}
            onClick={() => {
              setPaths((list) => [...list.slice(0, removed.at), removed.path, ...list.slice(removed.at)]);
              setRemoved(null);
            }}
          >
            Put it back
          </button>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {enough && paths.length < MAX_PATHS ? (
          <button type="button" className={button} onClick={() => { setSaid(null); setPaths((list) => [...list, { name: "", courses: [], order: "sequence" }]); }}>
            Add a path
          </button>
        ) : null}
        <button type="submit" className="btn btn-primary min-h-11" aria-disabled={busy || undefined}>
          {busy ? "Saving…" : "Save paths"}
        </button>
      </div>
      <p role="status" className={said ? (said.ok ? "text-sm text-ink" : "text-sm text-danger-text") : "sr-only"}>{said?.text ?? ""}</p>
      <p className="text-xs text-ink-mute">{`A store keeps up to ${MAX_PATHS} paths.`}</p>
    </form>
  );
}
