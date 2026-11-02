"use client";

import { IMPORT_ALLOWANCES } from "@/lib/import-limits";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { useStudioStore } from "@/components/studio-store-pin";
import { type ParsedCsv, csvLine, guessColumn, parseCsv, readConsent } from "@/lib/csv";
import { CLICKFUNNELS_EXAMPLES, CLICKFUNNELS_HEADERS, CLICKFUNNELS_LAST_NAME, readClickFunnelsStatus } from "@/lib/clickfunnels-csv";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { IMPORTS_PAUSED } from "@/lib/import-limits";
import { type DateOrder, datesInFile, letteredDate, readRenewal } from "@/lib/move-rules";

import { IMPORT_LEFT_WORDS, IMPORT_WORDS as WORDS, OUTCOME_WORDS, type ImportKind, type Outcome } from "@/lib/import-words";

export type { ImportKind } from "@/lib/import-words";

/** An import as the server reports it (app/api/store/import). */
export type ImportView = {
  id: string;
  kind: ImportKind;
  state: "receiving" | "queued" | "running" | "mailing" | "done" | "canceled" | "failed";
  file: string;
  at: number;
  finishedAt: number;
  expected: number;
  total: number;
  done: number;
  counts: { added: number; already: number; skipped: number; errors: number; mailed: number; unmailed: number; contacts?: number; stopped?: number };
  email: boolean;
  /** Where the file came from: any platform, or ClickFunnels' own exports. */
  source?: ImportSource;
};

export type ImportSource = "csv" | "clickfunnels";

/** Rows sent in one request: the server's own limit (lib/imports.ts, BATCH_ROWS). */
const BATCH = 1_000;
/** The biggest file read here. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

type Field = { key: string; label: string; required: boolean; names: string[]; hint?: string };

/** The fields of each kind, in the order the server takes them (lib/imports.ts, COLUMNS). */
const FIELDS: Record<ImportKind, Field[]> = {
  contacts: [
    { key: "email", label: "Email", required: true, names: ["email", "email address", "e-mail", "customer email", "subscriber email", "purchaser email"] },
    { key: "name", label: "Name", required: false, names: ["name", "full name", "first name", "customer name", "subscriber name"] },
    { key: "tags", label: "Tags", required: false, names: ["tags", "tag", "labels", "segments", "groups"] },
    {
      key: "consent",
      label: "Consent column",
      required: false,
      names: ["consent", "marketing consent", "opted in", "opt in", "accepts marketing", "email marketing", "subscribed", "marketing"],
      hint: "Optional. When the file says, row by row, whether each person agreed, only the yes rows are added.",
    },
  ],
  products: [
    { key: "title", label: "Title", required: true, names: ["title", "name", "product name", "product"] },
    { key: "price", label: "Price", required: false, names: ["price", "amount", "cost"] },
    { key: "description", label: "Description", required: false, names: ["description", "summary", "details"] },
    { key: "type", label: "Free or paid", required: false, names: ["type", "pricing", "free"], hint: "Optional. Without it, a price of 0 or none means free." },
    { key: "link", label: "Link", required: false, names: ["link", "url", "content url", "delivery url", "redirect url", "file url"] },
  ],
  purchases: [
    { key: "email", label: "Email", required: true, names: ["email", "customer email", "buyer email", "purchaser email", "email address"] },
    { key: "product", label: "Product", required: true, names: ["product", "product name", "product id", "item", "course", "title"], hint: "Its name or its id, as in your store here." },
    {
      key: "status",
      label: "Order status",
      required: false,
      names: ["status", "order status", "payment status", "billing status", "financial status"],
      hint: "Optional. Only paid orders give buyers what they bought: refunded, failed and canceled ones are left out.",
    },
  ],
  members: [
    { key: "email", label: "Email", required: true, names: ["email", "member email", "patron email", "customer email", "subscriber email", "email address"] },
    { key: "product", label: "Membership", required: true, names: ["membership", "membership name", "product", "product name", "product id", "offer"], hint: "Its name or its id, as in your store here." },
    {
      key: "renews",
      label: "Renews on",
      required: true,
      names: ["next charge date", "next billing date", "next payment date", "next payment", "next charge", "renews on", "renewal date", "renews", "current period end", "next bill date"],
      hint: "The day it would next renew where it is now, like Nov 3, 2026. The first payment here is taken that day.",
    },
    { key: "option", label: "Price", required: false, names: ["tier", "price option", "option", "level"], hint: "Only for a membership with several prices: the price's name, as in your store here." },
  ],
};

/** The same fields, named as ClickFunnels' exports name them (lib/clickfunnels-csv.ts). */
const CLICKFUNNELS_FIELDS: Record<"contacts" | "products" | "purchases", Field[]> = {
  contacts: [
    { key: "email", label: "Email", required: true, names: CLICKFUNNELS_HEADERS.contacts.email },
    { key: "name", label: "First name", required: false, names: CLICKFUNNELS_HEADERS.contacts.name },
    { key: "tags", label: "Tags", required: false, names: CLICKFUNNELS_HEADERS.contacts.tags },
    {
      key: "consent",
      label: "Status",
      required: false,
      names: CLICKFUNNELS_HEADERS.contacts.consent,
      hint: "ClickFunnels marks each contact Subscribed, Unsubscribed or Undeliverable. Without this column, everyone comes in as a contact you cannot email.",
    },
  ],
  products: [
    { key: "title", label: "Product name", required: true, names: CLICKFUNNELS_HEADERS.products.title },
    { key: "price", label: "Price", required: false, names: CLICKFUNNELS_HEADERS.products.price },
    { key: "description", label: "Description", required: false, names: CLICKFUNNELS_HEADERS.products.description },
    { key: "type", label: "Free or paid", required: false, names: CLICKFUNNELS_HEADERS.products.type, hint: "Optional. Without it, a price of 0 or none means free." },
    { key: "link", label: "Link", required: false, names: CLICKFUNNELS_HEADERS.products.link },
  ],
  purchases: [
    { key: "email", label: "Customer email", required: true, names: CLICKFUNNELS_HEADERS.purchases.email },
    { key: "product", label: "Product", required: true, names: CLICKFUNNELS_HEADERS.purchases.product, hint: "Its name or its id, as in your store here." },
    {
      key: "status",
      label: "Billing status",
      required: false,
      names: CLICKFUNNELS_HEADERS.purchases.status,
      hint: "Only paid orders give buyers what they bought: refunded, failed and canceled ones are left out.",
    },
  ],
};

const fieldsFor = (kind: ImportKind, source: ImportSource): Field[] => (source === "clickfunnels" && kind !== "members" ? CLICKFUNNELS_FIELDS[kind] : FIELDS[kind]);

const LIMITS: Record<ImportKind, number> = { contacts: 50_000, products: 500, purchases: 20_000, members: 20_000 };

const EXAMPLES: Record<ImportKind, string> = {
  contacts: "email,name,tags,consent\r\nada@example.com,Ada Lovelace,\"vip, buyers\",yes\r\n",
  products: "title,price,description,type,link\r\nThe starter guide,19,A short guide to getting started.,paid,https://example.com/guide\r\nFree checklist,0,One page to print.,free,https://example.com/checklist\r\n",
  purchases: "email,product,status\r\nada@example.com,The starter guide,paid\r\n",
  members: "email,membership,renews on,price\r\nada@example.com,The Inner Circle,2026-11-03,\r\n",
};

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  busy: "Another import is running on this store. Wait for it to finish, or cancel it, and start this one after.",
  too_many: "That is more rows than this import takes. Split the file and bring it in parts.",
  consent: "Check the box to confirm these people agreed to receive your emails. Nobody is added without it.",
  email: "Emailing buyers needs your store's plan to be active. Uncheck the box, or start your plan first.",
  members_email: "Moving members needs your store's plan to be active: each member is emailed their own link.",
  stripe: "Members keep their membership by paying on your own Stripe account. Connect Stripe first.",
  stopped: "Check the box to confirm you will stop these memberships renewing where they are now.",
  date_order: "Choose how this file writes dates, from the list above the first rows.",
  list: "Your store's list could not be set up. Try again in a moment.",
  store: "Open the studio once, then come back here.",
  rows: "Part of the file could not be sent. Try again.",
  state: "This import is no longer taking rows. Start it again.",
  unknown: "That import is no longer here. Start it again.",
  slow: "That was a lot in a short time. Wait a while and try again.",
  rows_month: "Your plan's imported rows for this month are used. The rest of the file can come in when the month turns, or on a larger plan.",
  starts_month: "Your plan's imports for this month are started. More can start when the month turns, or on a larger plan.",
  checks_month: "Your plan's dry runs for this month are used. You can still import the file; dry runs open again when the month turns.",
  signed_out: "Your session ended. Log in again.",
  role: "Only the store's owner and Admins can import.",
  unavailable: "Imports are not switched on yet.",
  server_error: "Something went wrong on our side. Nothing more was changed. Try again in a moment.",
  kind: "This import has no dry run.",
  // 232 [CA1] unit 4b2: in place of the studio's words about uploads.
  renewal_unpaid: IMPORTS_PAUSED.renewal_unpaid,
  plan_disputed: IMPORTS_PAUSED.plan_disputed,
};

const running = (state: ImportView["state"]) => state === "receiving" || state === "queued" || state === "running" || state === "mailing";

/** The progress of one import, and what came of it. */
export function ImportProgress({
  job,
  onCancel,
  busy,
  compact = false,
}: {
  job: ImportView;
  onCancel?: () => void;
  busy?: boolean;
  /** In a narrow column: the counts two to a row. */
  compact?: boolean;
}) {
  const sid = useStudioStore();
  const words = WORDS[job.kind];
  const shownTotal = job.state === "receiving" ? job.expected : Math.max(job.total, 1);
  const count = job.state === "receiving" ? job.total : job.done;
  const percent = Math.min(100, Math.round((count / Math.max(shownTotal, 1)) * 100));
  const label =
    job.state === "receiving"
      ? `Sending the file: ${job.total.toLocaleString("en-US")} of ${job.expected.toLocaleString("en-US")} rows`
      : job.state === "mailing"
        ? `Emailing ${job.kind === "members" ? "members" : "buyers"}: ${job.counts.mailed.toLocaleString("en-US")} sent`
        : running(job.state)
          ? `Bringing it in: ${job.done.toLocaleString("en-US")} of ${job.total.toLocaleString("en-US")} rows`
          : job.state === "done"
            ? "Finished"
            : job.state === "canceled"
              ? "Canceled. What was brought in before stays."
              : "Stopped: the store is no longer there.";
  const report = `/api/store/import?${new URLSearchParams({ id: job.id, report: "1", ...(sid ? { store: sid } : {}) })}`;
  return (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-line" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{label}</p>
        {running(job.state) ? <p className="text-sm tabular-nums text-ink-soft">{`${percent}%`}</p> : null}
      </div>
      {running(job.state) ? (
        <div
          className="mt-2 h-2.5 overflow-hidden rounded-full bg-sand"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="Import progress"
        >
          <div className="h-full rounded-full bg-violet-brand transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      <dl className={`mt-3 grid grid-cols-2 gap-2 text-sm ${compact ? "" : "sm:grid-cols-4"}`}>
        <div className="rounded-xl bg-mint-soft px-3 py-2">
          <dt className="text-xs font-semibold text-mint-deep">{words.added}</dt>
          <dd className="font-bold tabular-nums text-ink">{job.counts.added.toLocaleString("en-US")}</dd>
        </div>
        <div className="rounded-xl bg-paper px-3 py-2">
          <dt className="text-xs font-semibold text-ink-soft">{words.already}</dt>
          <dd className="font-bold tabular-nums text-ink">{job.counts.already.toLocaleString("en-US")}</dd>
        </div>
        <div className="rounded-xl bg-paper px-3 py-2">
          <dt className="text-xs font-semibold text-ink-soft">{IMPORT_LEFT_WORDS.skipped}</dt>
          <dd className="font-bold tabular-nums text-ink">{job.counts.skipped.toLocaleString("en-US")}</dd>
        </div>
        <div className={`rounded-xl px-3 py-2 ${job.counts.errors ? "bg-danger-soft" : "bg-paper"}`}>
          <dt className={`text-xs font-semibold ${job.counts.errors ? "text-danger" : "text-ink-soft"}`}>{IMPORT_LEFT_WORDS.errors}</dt>
          <dd className="font-bold tabular-nums text-ink">{job.counts.errors.toLocaleString("en-US")}</dd>
        </div>
        {job.kind === "contacts" && (job.counts.contacts || job.counts.stopped) ? (
          <>
            <div className="rounded-xl bg-paper px-3 py-2">
              <dt className="text-xs font-semibold text-ink-soft">contacts you cannot email</dt>
              <dd className="font-bold tabular-nums text-ink">{(job.counts.contacts ?? 0).toLocaleString("en-US")}</dd>
            </div>
            <div className="rounded-xl bg-paper px-3 py-2">
              <dt className="text-xs font-semibold text-ink-soft">no longer emailed</dt>
              <dd className="font-bold tabular-nums text-ink">{(job.counts.stopped ?? 0).toLocaleString("en-US")}</dd>
            </div>
          </>
        ) : null}
      </dl>
      {job.email && (job.counts.mailed || job.counts.unmailed || job.state === "mailing") ? (
        <p className="mt-2 text-xs text-ink-soft">
          {`${job.counts.mailed.toLocaleString("en-US")} ${job.kind === "members" ? "members" : "buyers"} emailed${job.counts.unmailed ? `, ${job.counts.unmailed.toLocaleString("en-US")} could not be` : ""}.`}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        {job.counts.errors + job.counts.skipped > 0 && !running(job.state) ? (
          <a href={report} className="inline-flex min-h-11 items-center gap-1.5 font-bold text-violet-deep underline underline-offset-4">
            <Icon name="download" size={15} />
            Download the rows that were not brought in
          </a>
        ) : null}
        {running(job.state) && onCancel ? (
          <button type="button" onClick={onCancel} disabled={busy} className="btn btn-ghost btn-sm">
            Cancel the import
          </button>
        ) : null}
        {running(job.state) ? (
          <p className="text-xs text-ink-soft">You can leave this page: it carries on by itself, a little every five minutes.</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One import, from choosing the file to the end: the file is read here, the
 * creator says which column is which, and the rows go to the server in
 * batches. The server checks every row again and does the work in chunks,
 * which this page keeps moving while it is open.
 */
export function ImportTool({
  kind,
  active,
  canEmail,
  storeName,
  source = "csv",
}: {
  kind: ImportKind;
  /** The store's import that is running now, when there is one. */
  active: ImportView | null;
  /** Whether buyers may be emailed about their purchases (an active plan). */
  canEmail: boolean;
  storeName: string;
  /** ClickFunnels' own exports: their column names, its consent statuses, and a dry run before importing. */
  source?: ImportSource;
}) {
  const router = useRouter();
  const fields = fieldsFor(kind, source);
  const fromClickFunnels = source === "clickfunnels" && kind !== "members";
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [lastName, setLastName] = useState(-1);
  const [agreed, setAgreed] = useState(false);
  const [tags, setTags] = useState("");
  const [email, setEmail] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [chosenOrder, setDateOrder] = useState<DateOrder | "">("");
  const [job, setJob] = useState<ImportView | null>(active && active.kind === kind ? active : null);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [checking, setChecking] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stepping = useRef(false);
  // Bumped when a step did not go through, so the next one is tried again.
  const [missed, setMissed] = useState(0);
  const other = active && active.kind !== kind && running(active.state) ? active : null;

  const post = useCallback(async (payload: Record<string, unknown>) => {
    const response = await fetch("/api/store/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as { ok?: boolean; error?: string; import?: ImportView; limit?: number };
  }, []);

  // While the page is open, a running import is moved along a step at a time.
  useEffect(() => {
    if (!job || job.state === "receiving" || !running(job.state) || stepping.current) return;
    stepping.current = true;
    const timer = setTimeout(async () => {
      let moved = false;
      try {
        const data = await post({ action: "step", id: job.id });
        if (data.ok && data.import) {
          moved = true;
          // Paid again: the pause words go.
          setError((e) => (e === MESSAGES.renewal_unpaid || e === MESSAGES.plan_disputed ? null : e));
          setJob(data.import);
          if (!running(data.import.state)) {
            toast(data.import.state === "done" ? "Import finished." : "Import stopped.");
            router.refresh();
          }
        } else if (data.error === "renewal_unpaid" || data.error === "plan_disputed") {
          // Said beside the import; it is tried again below and goes on once paid (232 [CA1] unit 4b2).
          setError(MESSAGES[data.error]);
        }
      } catch {
        // Tried again below; the five-minute job carries on meanwhile.
      } finally {
        stepping.current = false;
      }
      setMissed((n) => (moved ? 0 : n + 1));
    }, missed ? Math.min(30_000, 900 * 2 ** Math.min(missed, 5)) : 900);
    return () => {
      clearTimeout(timer);
      stepping.current = false;
    };
  }, [job, post, router, missed]);

  async function choose(file: File | undefined) {
    setError(null);
    setParsed(null);
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError("That file is over 25 MB. Split it and bring it in parts.");
      return;
    }
    const text = await file.text();
    const read = parseCsv(text, LIMITS[kind]);
    if (read.header.length === 0 || read.rows.length === 0) {
      setError("That file has no rows under its first line. It needs a first line naming the columns, then one row per entry.");
      return;
    }
    if (read.truncated) {
      setError(`That file has more than ${LIMITS[kind].toLocaleString("en-US")} rows, the most one import takes. Split it and bring it in parts.`);
      return;
    }
    setDateOrder("");
    const guessed: Record<string, number> = {};
    for (const field of fields) guessed[field.key] = guessColumn(read.header, field.names);
    // Kajabi and others keep first and last names apart: joined here.
    const first = guessed.name ?? -1;
    const last =
      kind === "contacts" && first >= 0 && /first/i.test(read.header[first] ?? "")
        ? guessColumn(read.header, fromClickFunnels ? CLICKFUNNELS_LAST_NAME : ["last name", "surname", "family name"])
        : -1;
    setMapping(guessed);
    setLastName(last);
    setParsed(read);
    setFileName(file.name);
  }

  /** The rows as the server takes them: the row number, then each field. */
  const rows = useMemo(() => {
    if (!parsed) return [];
    return parsed.rows.map((row, i) => {
      const cell = (key: string) => {
        const at = mapping[key] ?? -1;
        return at >= 0 ? (row[at] ?? "").trim() : "";
      };
      const cells = fields.map((field) => {
        if (field.key === "name" && lastName >= 0) return [cell("name"), (row[lastName] ?? "").trim()].filter(Boolean).join(" ");
        return cell(field.key);
      });
      return [String(parsed.lines[i] ?? i + 2), ...cells];
    });
  }, [parsed, mapping, lastName, fields]);

  const missing = fields.filter((f) => f.required && (mapping[f.key] ?? -1) < 0);
  // Members: whether some dates could be read two ways, and an example of one,
  // so the creator chooses once, from a list, how the whole file writes them.
  const dates = useMemo(() => (kind === "members" && (mapping.renews ?? -1) >= 0 ? datesInFile(rows.map((row) => row[3])) : null), [kind, mapping, rows]);
  const twoWaysSample = useMemo(() => (dates?.twoWays ? rows.map((row) => row[3]).find((v) => { const r = readRenewal(v); return !r.ok && r.reason === "ambiguous"; }) ?? "" : ""), [dates, rows]);
  // What the creator chose, or else what the file's other dates prove.
  const dateOrder: DateOrder | "" = chosenOrder || dates?.proves || "";
  const consentPreview =
    kind === "contacts" && (mapping.consent ?? -1) >= 0
      ? rows.reduce((n, row) => n + ((fromClickFunnels ? readClickFunnelsStatus(row[4]) === "subscribed" : readConsent(row[4]) === "yes") ? 1 : 0), 0)
      : null;
  // What the dry run was made with: changing any of it makes it out of date.
  const signature = JSON.stringify([fileName, rows.length, mapping, lastName, agreed, tags, email]);
  const dryFresh = dry !== null && dry.signature === signature && dry.complete;
  const canPreview = kind !== "members";
  const options = () => ({
    kind,
    source,
    expected: rows.length,
    file: fileName,
    agreed: kind === "contacts" ? agreed : undefined,
    consentColumn: kind === "contacts" ? (mapping.consent ?? -1) >= 0 : undefined,
    tags: kind === "contacts" ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
    email: kind === "purchases" ? email : undefined,
    stopped: kind === "members" ? stopped : undefined,
    dateOrder: kind === "members" ? dateOrder : undefined,
  });

  /** The dry run: every row sent to be checked the way the import checks it, a batch at a time; nothing is saved. */
  async function check() {
    if (!parsed) return;
    setError(null);
    if (missing.length) {
      setError(`Choose the column for ${missing.map((f) => f.label.toLowerCase()).join(" and ")}.`);
      return;
    }
    if (kind === "contacts" && !agreed && !fromClickFunnels) {
      setError(MESSAGES.consent);
      return;
    }
    setChecking(1);
    const collected: PreviewRow[] = [];
    let room: number | null = null;
    try {
      for (let from = 0; from < rows.length; from += BATCH) {
        const data = (await (
          await fetch("/api/store/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "preview", ...options(), rows: rows.slice(from, from + BATCH) }),
          })
        ).json().catch(() => ({ ok: false, error: "server_error" }))) as { ok?: boolean; error?: string; rows?: PreviewRow[]; room?: number | null };
        if (!data.ok || !Array.isArray(data.rows)) {
          setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
          setDry(null);
          return;
        }
        if (room === null && typeof data.room === "number") room = data.room;
        collected.push(...data.rows);
        setChecking(Math.min(rows.length, from + BATCH));
      }
      setDry(tally(kind, collected, room, signature));
    } catch {
      setError(MESSAGES.server_error);
      setDry(null);
    } finally {
      setChecking(0);
    }
  }

  async function start() {
    if (!parsed) return;
    setError(null);
    if (missing.length) {
      setError(`Choose the column for ${missing.map((f) => f.label.toLowerCase()).join(" and ")}.`);
      return;
    }
    if (kind === "contacts" && !agreed && !fromClickFunnels) {
      setError(MESSAGES.consent);
      return;
    }
    if (fromClickFunnels && !dryFresh) {
      setError("Check the file first: the dry run shows what each row will become, and nothing is saved until you import.");
      return;
    }
    if (kind === "members" && !stopped) {
      setError(MESSAGES.stopped);
      return;
    }
    if (kind === "members" && dates?.twoWays && !dateOrder) {
      setError(MESSAGES.date_order);
      return;
    }
    setBusy(true);
    let current: ImportView | null = null;
    // Only a file still being sent is let go of when something fails; once
    // "finish" is asked for, the import may already be running.
    let sending = true;
    try {
      const begun = await post({ action: "start", ...options() });
      if (!begun.ok || !begun.import) {
        setError((kind === "members" && begun.error === "email" ? MESSAGES.members_email : MESSAGES[begun.error ?? ""]) ?? MESSAGES.server_error);
        return;
      }
      current = begun.import;
      setJob(current);
      for (let from = 0; from < rows.length; from += BATCH) {
        const sent = await post({ action: "rows", id: current.id, rows: rows.slice(from, from + BATCH) });
        if (!sent.ok || !sent.import) {
          setError(MESSAGES[sent.error ?? ""] ?? MESSAGES.server_error);
          await post({ action: "cancel", id: current.id }).catch(() => null);
          setJob(null);
          return;
        }
        current = sent.import;
        setJob(current);
      }
      sending = false;
      const finished = await post({ action: "finish", id: current.id });
      if (!finished.ok || !finished.import) {
        // Refused: let go of, so the file can be chosen again. No answer that
        // can be read: it may have started, so it is left as it is.
        if (finished.error && finished.error !== "server_error") {
          setError(MESSAGES[finished.error] ?? MESSAGES.server_error);
          await post({ action: "cancel", id: current.id }).catch(() => null);
          setJob(null);
        } else {
          setError("We could not tell whether your import started. Reload the page to see it.");
        }
        return;
      }
      setJob(finished.import);
      setParsed(null);
      setDry(null);
      if (!running(finished.import.state)) {
        toast("Import finished.");
        router.refresh();
      }
    } catch {
      setError(sending ? MESSAGES.server_error : "We could not tell whether your import started. Reload the page to see it.");
      // A file only partly sent is let go of, so it can be chosen again.
      if (sending && current && current.state === "receiving") {
        const id = current.id;
        await post({ action: "cancel", id }).catch(() => null);
        setJob(null);
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!job) return;
    setBusy(true);
    try {
      const data = await post({ action: "cancel", id: job.id });
      if (data.ok && data.import) {
        setJob(data.import);
        toast("Import canceled.");
        router.refresh();
      } else setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  const example = `data:text/csv;charset=utf-8,${encodeURIComponent(fromClickFunnels ? CLICKFUNNELS_EXAMPLES[kind] : EXAMPLES[kind])}`;
  const showPicker = !job || !running(job.state);

  return (
    <div className="space-y-5">
      {other ? (
        <p className="notice notice-warn text-sm">
          {`An import of ${WORDS[other.kind].noun} is running on this store. It has to finish, or be canceled, before another starts.`}
        </p>
      ) : null}

      {job ? <ImportProgress job={job} onCancel={cancel} busy={busy} /> : null}

      {showPicker && !other ? (
        <div className="space-y-5">
          <div className="rounded-2xl border-2 border-dashed border-line-strong bg-white p-5 text-center">
            <Icon name="file" size={24} className="mx-auto text-violet-deep" />
            <label htmlFor={`file-${kind}`} className="mt-2 block font-semibold text-ink">
              {parsed ? `${fileName}: ${parsed.rows.length.toLocaleString("en-US")} rows` : "Choose a CSV file"}
            </label>
            <p className="mt-1 text-xs text-ink-soft">
              {`Up to ${LIMITS[kind].toLocaleString("en-US")} rows. Commas, semicolons or tabs; UTF-8, as most platforms export it.`}
            </p>
            <input
              id={`file-${kind}`}
              type="file"
              accept=".csv,.tsv,.txt,text/csv"
              onChange={(e) => choose(e.target.files?.[0])}
              className="mx-auto mt-3 block w-full max-w-xs text-sm file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-full file:border-0 file:bg-lilac file:px-4 file:font-bold file:text-violet-deep"
            />
            <a href={example} download={`example-${kind}.csv`} className="mt-3 inline-block text-xs font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep">
              Download an example file
            </a>
          </div>

          {parsed ? (
            <>
              <fieldset className="rounded-2xl bg-white p-4 ring-1 ring-line">
                <legend className="px-1 text-sm font-bold text-ink">Which column is which</legend>
                <div className="grid gap-4 sm:grid-cols-2">
                  {fields.map((field) => (
                    <label key={field.key} className="block" htmlFor={`map-${kind}-${field.key}`}>
                      <span className="field-label">{`${field.label}${field.required ? "" : " (optional)"}`}</span>
                      <select
                        id={`map-${kind}-${field.key}`}
                        className="field"
                        value={mapping[field.key] ?? -1}
                        onChange={(e) => setMapping((m) => ({ ...m, [field.key]: Number(e.target.value) }))}
                        aria-invalid={field.required && (mapping[field.key] ?? -1) < 0 ? true : undefined}
                      >
                        <option value={-1}>{field.required ? "Choose a column" : "Not in this file"}</option>
                        {parsed.header.map((name, i) => (
                          <option key={i} value={i}>
                            {name || `Column ${i + 1}`}
                          </option>
                        ))}
                      </select>
                      {field.hint ? <span className="field-hint">{field.hint}</span> : null}
                    </label>
                  ))}
                  {kind === "contacts" && (mapping.name ?? -1) >= 0 ? (
                    <label className="block" htmlFor={`map-${kind}-last`}>
                      <span className="field-label">Last name (optional, joined to the name)</span>
                      <select id={`map-${kind}-last`} className="field" value={lastName} onChange={(e) => setLastName(Number(e.target.value))}>
                        <option value={-1}>Not in this file</option>
                        {parsed.header.map((name, i) => (
                          <option key={i} value={i}>
                            {name || `Column ${i + 1}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              </fieldset>

              <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-line">
                <table className="w-full min-w-[28rem] text-left text-sm">
                  <caption className="px-4 pt-3 text-left text-xs font-bold text-ink-soft">The first rows, as they will be read</caption>
                  <thead>
                    <tr className="text-xs text-ink-mute">
                      <th scope="col" className="px-4 py-2 font-semibold">Row</th>
                      {fields.map((f) => (
                        <th key={f.key} scope="col" className="px-4 py-2 font-semibold">
                          {f.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 4).map((row) => (
                      <tr key={row[0]} className="border-t border-line">
                        {row.map((cell, i) => {
                          // A renewal date is shown as it will be read, with the month in letters, to be checked.
                          const read = kind === "members" && i === 3 && cell ? readRenewal(cell, dateOrder) : null;
                          return (
                            <td key={i} className={`max-w-[14rem] truncate px-4 py-2 ${i === 0 ? "tabular-nums text-ink-mute" : "text-ink"}`}>
                              {read ? (
                                read.ok ? (
                                  <span><span className="font-semibold">{letteredDate(read.at)}</span><span className="text-ink-mute">{` (${cell})`}</span></span>
                                ) : (
                                  <span className="text-danger">{`${cell}: ${read.reason === "ambiguous" ? "choose how dates are written" : "cannot be read"}`}</span>
                                )
                              ) : (
                                cell || <span className="text-ink-mute">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {kind === "contacts" ? (
                <div className="space-y-4 rounded-2xl bg-white p-4 ring-1 ring-line">
                  {fromClickFunnels ? (
                    <label htmlFor="import-agreed" className="flex cursor-pointer items-start gap-3">
                      <input id="import-agreed" type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1 h-5 w-5 shrink-0" />
                      <span className="text-sm text-ink">
                        <strong>The contacts marked Subscribed agreed to receive my emails.</strong>{" "}
                        <span className="text-ink-soft">
                          Only they can be emailed here, and only with this checked. Everyone else comes in as a contact you cannot email. Those marked
                          Unsubscribed or Undeliverable are kept as unsubscribed here, so no later import makes them people you email. Nobody is
                          emailed because of the import.
                        </span>
                      </span>
                    </label>
                  ) : (
                    <label htmlFor="import-agreed" className="flex cursor-pointer items-start gap-3">
                      <input id="import-agreed" type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1 h-5 w-5 shrink-0" />
                      <span className="text-sm text-ink">
                        <strong>These people agreed to receive my emails.</strong>{" "}
                        <span className="text-ink-soft">
                          Only people who said yes to hearing from you may be imported. Nobody who unsubscribed from your list here is added back,
                          whatever the file says, and nobody is emailed because of the import.
                        </span>
                      </span>
                    </label>
                  )}
                  {consentPreview !== null ? (
                    <p className="text-sm text-ink-soft">
                      {fromClickFunnels
                        ? `The Status column says Subscribed for ${consentPreview.toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")} rows.`
                        : `The consent column says yes for ${consentPreview.toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")} rows. Only those are added.`}
                    </p>
                  ) : fromClickFunnels ? (
                    <p className="notice notice-warn text-sm">
                      No Status column is matched, so every contact comes in as one you cannot email. To bring your subscribers, export your contacts
                      again in ClickFunnels with the Status field included.
                    </p>
                  ) : null}
                  <label className="block" htmlFor="import-tags">
                    <span className="field-label">Tag everyone in this file (optional)</span>
                    <input id="import-tags" className="field" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="from-stan, 2026" maxLength={200} />
                    <span className="field-hint">Separate tags with commas. They go with each contact, next to any tags the file has.</span>
                  </label>
                </div>
              ) : kind === "products" ? (
                <p className="notice notice-info text-sm">
                  Each row becomes a draft: kept in your studio and not on your store until you publish it. Prices are read in your
                  store&apos;s currency. A file for a product is added afterward, from its row in the studio.
                </p>
              ) : kind === "members" ? (
                <div className="space-y-3 rounded-2xl bg-white p-4 ring-1 ring-line">
                  {dates?.twoWays ? (
                    <label className="block" htmlFor="import-date-order">
                      <span className="field-label">How this file writes dates</span>
                      <select
                        id="import-date-order"
                        className="field"
                        value={dateOrder}
                        onChange={(e) => setDateOrder(e.target.value === "mdy" || e.target.value === "dmy" ? e.target.value : "")}
                        aria-invalid={!dateOrder ? true : undefined}
                      >
                        <option value="">Choose one</option>
                        {(["mdy", "dmy"] as const).map((order) => {
                          const read = readRenewal(twoWaysSample, order);
                          return (
                            <option key={order} value={order}>
                              {`${order === "mdy" ? "Month first" : "Day first"}: ${twoWaysSample} is ${read.ok ? letteredDate(read.at) : "not a date"}`}
                            </option>
                          );
                        })}
                      </select>
                      <span className="field-hint">
                        {`Some dates in the file, like ${twoWaysSample}, could be read two ways. Choose once for the whole file; the first rows below show each date with its month in letters, to check.${dates.proves ? " Other dates in the file already show which it is, so it is chosen for you." : ""}`}
                      </span>
                    </label>
                  ) : null}
                  {dates?.mixed ? (
                    <p className="notice notice-warn text-sm">
                      This file writes dates in two ways. The rows that do not fit the order chosen are listed in the report, not guessed.
                    </p>
                  ) : null}
                  <p className="text-sm text-ink-soft">
                    {`Each member gets one email from ${storeName}'s name with their own link to keep their membership here, on your Stripe account. Nothing is charged until the date in the file, the day it would have renewed where it is now, so nobody pays twice for the same weeks; a date less than two days away is charged when they keep it. A member who has not kept it gets one reminder three days before that date. Nobody gets the membership without keeping it.`}
                  </p>
                  {!canEmail ? <p className="notice notice-warn text-sm">{MESSAGES.members_email}</p> : null}
                  <label htmlFor="import-stopped" className="flex cursor-pointer items-start gap-3">
                    <input id="import-stopped" type="checkbox" checked={stopped} onChange={(e) => setStopped(e.target.checked)} className="mt-1 h-5 w-5 shrink-0" />
                    <span className="text-sm text-ink">
                      <strong>I will stop these memberships renewing where they are now, before their renewal dates.</strong>{" "}
                      <span className="text-ink-soft">
                        Otherwise a member who keeps theirs here would be charged in both places. Only you can do this, on the other platform.
                      </span>
                    </span>
                  </label>
                </div>
              ) : (
                <div className="space-y-3 rounded-2xl bg-white p-4 ring-1 ring-line">
                  <p className="text-sm text-ink-soft">
                    {`Each buyer in the file can open what they bought on ${storeName}'s orders page, using the email in the file; it is marked there as brought over from another platform. They also get into your community when that product includes it. Nothing is charged and no receipt is sent. Memberships and calls cannot be given this way.`}
                  </p>
                  <label htmlFor="import-email" className={`flex items-start gap-3 ${canEmail ? "cursor-pointer" : "opacity-60"}`}>
                    <input id="import-email" type="checkbox" checked={email} disabled={!canEmail} onChange={(e) => setEmail(e.target.checked)} className="mt-1 h-5 w-5 shrink-0" />
                    <span className="text-sm text-ink">
                      {`Email each buyer once, to say their purchases moved to ${storeName}`}
                      <span className="block text-ink-soft">
                        {canEmail
                          ? `One email per buyer, from your store's name, with how to open what they have. Nothing else is sent. On Studio and Scale they count in your monthly emails; on Store, up to ${IMPORT_ALLOWANCES.creator.movedEmails} a month.`
                          : "Needs your store's plan to be active."}
                      </span>
                    </span>
                  </label>
                </div>
              )}

              {dry && dry.signature === signature ? <DryRunReport kind={kind} dry={dry} /> : null}

              <div className="flex flex-wrap items-center gap-3">
                {canPreview ? (
                  <button
                    type="button"
                    onClick={check}
                    disabled={busy || checking > 0}
                    aria-busy={checking > 0}
                    className={fromClickFunnels && !dryFresh ? "btn btn-primary" : "btn btn-ghost"}
                  >
                    {checking > 0
                      ? `Checking… ${checking.toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")}`
                      : dryFresh
                        ? "Check the file again"
                        : "Check the file first (nothing is saved)"}
                  </button>
                ) : null}
                {!fromClickFunnels || dryFresh ? (
                  <button type="button" onClick={start} disabled={busy || checking > 0} aria-busy={busy} className="btn btn-primary">
                    {busy ? "Importing…" : `Import ${rows.length.toLocaleString("en-US")} ${rows.length === 1 ? "row" : "rows"}`}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setParsed(null);
                    setDry(null);
                  }}
                  disabled={busy}
                  className="btn btn-ghost"
                >
                  Choose another file
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** One row of a dry run, as the server answers it (lib/imports.ts, PreviewRow). */
type PreviewRow = [line: number, outcome: Outcome, column: string, note: string, value: string, key: string, fresh: 0 | 1];

/** A whole file's dry run, added up here from the server's answers for each batch. */
type DryRun = { signature: string; complete: boolean; rows: PreviewRow[]; counts: Record<Outcome, number> };

/**
 * Adds up the dry run's batches: a row repeated in another batch, which the
 * server could not see, is left out as the import will leave it out, and
 * rows past the room the list or the store has left are said not to fit.
 */
function tally(kind: ImportKind, collected: PreviewRow[], room: number | null, signature: string): DryRun {
  const first = new Map<string, number>();
  let used = 0;
  const counts: Record<Outcome, number> = { added: 0, contact: 0, already: 0, stopped: 0, left: 0, skipped: 0, error: 0 };
  const rows = collected
    .slice()
    .sort((a, b) => a[0] - b[0])
    .map((row): PreviewRow => {
      const [line, outcome, , , value, key, fresh] = row;
      if (key && outcome !== "skipped" && outcome !== "error") {
        const earlier = first.get(key);
        if (earlier !== undefined && earlier !== line) {
          const words = kind === "contacts" ? "The same address as row" : kind === "products" ? "The same title as row" : "The same buyer and product as row";
          return [line, "skipped", row[2], `${words} ${earlier}`, value, key, 0];
        }
        first.set(key, line);
      }
      if (fresh && room !== null) {
        used += 1;
        if (used > room) return [line, "error", row[2], kind === "contacts" ? "Your list is full" : "Your store is full", value, key, 0];
      }
      return row;
    });
  for (const row of rows) counts[row[1]] += 1;
  return { signature, complete: true, rows, counts };
}

const NO_WORDS: Partial<Record<Outcome, string>> = {};

/** The dry run, shown: what each kind of row will become, the rows worth a look, and all of it as a spreadsheet. */
function DryRunReport({ kind, dry }: { kind: ImportKind; dry: DryRun }) {
  const words: Partial<Record<Outcome, string>> = kind === "members" ? NO_WORDS : OUTCOME_WORDS[kind];
  const shown = (Object.keys(words) as Outcome[]).filter((o) => dry.counts[o] > 0 || o === "added");
  const notable = dry.rows.filter((row) => row[1] !== "added");
  // Made when asked for: a file of fifty thousand rows is not kept in the page.
  const save = () => {
    const lines = [csvLine(["row", "becomes", "column", "why", "value"])];
    for (const [line, outcome, column, note, value] of dry.rows) lines.push(csvLine([line, words[outcome] ?? outcome, column, note, value]));
    const url = URL.createObjectURL(new Blob([`\uFEFF${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `dry-run-${kind}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <section className="rounded-2xl bg-white p-4 ring-1 ring-line" aria-labelledby={`dry-${kind}`} aria-live="polite">
      <h3 id={`dry-${kind}`} className="text-sm font-bold text-ink">
        Dry run: what this file will do
      </h3>
      <p className="mt-1 text-xs text-ink-soft">
        Every row was checked the way the import checks it, against your store as it is now. Nothing was saved. The import checks every row
        again when it runs.
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {shown.map((outcome) => (
          <div key={outcome} className={`rounded-xl px-3 py-2 ${outcome === "added" ? "bg-mint-soft" : outcome === "error" ? "bg-danger-soft" : "bg-paper"}`}>
            <dt className={`text-xs font-semibold ${outcome === "added" ? "text-mint-deep" : outcome === "error" ? "text-danger" : "text-ink-soft"}`}>{words[outcome]}</dt>
            <dd className="font-bold tabular-nums text-ink">{dry.counts[outcome].toLocaleString("en-US")}</dd>
          </div>
        ))}
      </dl>
      {notable.length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <caption className="text-left text-xs font-bold text-ink-soft">
              {notable.length > 50 ? `The first 50 of ${notable.length.toLocaleString("en-US")} rows worth a look` : "Rows worth a look"}
            </caption>
            <thead>
              <tr className="text-xs text-ink-mute">
                <th scope="col" className="px-2 py-2 font-semibold">Row</th>
                <th scope="col" className="px-2 py-2 font-semibold">Becomes</th>
                <th scope="col" className="px-2 py-2 font-semibold">Why</th>
                <th scope="col" className="px-2 py-2 font-semibold">Value</th>
              </tr>
            </thead>
            <tbody>
              {notable.slice(0, 50).map(([line, outcome, , note, value]) => (
                <tr key={line} className="border-t border-line align-top">
                  <td className="px-2 py-2 tabular-nums text-ink-mute">{line}</td>
                  <td className={`px-2 py-2 ${outcome === "error" ? "font-semibold text-danger" : "text-ink"}`}>{words[outcome] ?? outcome}</td>
                  <td className="px-2 py-2 text-ink-soft">{note}</td>
                  <td className="max-w-[12rem] truncate px-2 py-2 text-ink">{value || <span className="text-ink-mute">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <button type="button" onClick={save} className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-sm font-bold text-violet-deep underline underline-offset-4">
        <Icon name="download" size={15} />
        Download the dry run, every row
      </button>
    </section>
  );
}
