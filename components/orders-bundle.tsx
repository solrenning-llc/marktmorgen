"use client";

import { useId, useState } from "react";
import { BundleDelivery, type BundleWords } from "@/components/bundle-delivery";
import { LicenceKeyBox, type LicenceKeyWords } from "@/components/licence-key-box";

/** One product of the bundle, as app/api/store/orders/bundle/route.ts answers it. */
export type OrdersBundleLine = {
  id: string;
  title: string;
  link: string | null;
  download: string | null;
  course: string | null;
  key: { label: string; value: string | null; revoked: boolean; waiting: boolean } | null;
};

/** What the route answers: the products, and what is said about the ones the store no longer has; or why not. */
export type OrdersBundleAnswer = { ok: true; lines: OrdersBundleLine[]; missing: string | null } | { ok: false; message: string };

/** Everything the box says, in the store's language (lib/buyer-words/orders.ts), with the titles already in. */
export type OrdersBundleWords = {
  heading: string;
  show: string;
  hide: string;
  loading: string;
  failed: string;
  bundle: Omit<BundleWords, "missing">;
  key: Omit<LicenceKeyWords, "label">;
};

/**
 * A bundle on the list of purchases: its name, and a button that shows its
 * products (the WAI-ARIA disclosure pattern: the button says whether they are
 * shown and names what it shows, focus stays on it, and the products follow it).
 * They are read only when asked for, from `address`, a request that pays for
 * itself before anything is read (lib/buyer-orders.ts, bundleFor), so an
 * opening of the list never draws every product of every bundle (C3-80).
 * Shown once, they stay: hiding and showing them again reads nothing more.
 */
export function OrdersBundle({ address, storeName, words }: { address: string; storeName: string; words: OrdersBundleWords }) {
  const panel = useId();
  const head = useId();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState("");
  const [shown, setShown] = useState<{ lines: OrdersBundleLine[]; missing: string | null } | null>(null);

  async function load() {
    setLoading(true);
    setProblem("");
    let said = words.failed;
    try {
      const response = await fetch(address, { cache: "no-store", headers: { Accept: "application/json" } });
      const answer = (await response.json().catch(() => null)) as OrdersBundleAnswer | null;
      if (answer?.ok) {
        setShown({ lines: answer.lines, missing: answer.missing });
        setLoading(false);
        return;
      }
      if (answer && !answer.ok && answer.message) said = answer.message;
    } catch {
      // The connection failed: said as the products not shown, and the button offers them again.
    }
    setLoading(false);
    setOpen(false);
    setProblem(said);
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !shown && !loading) void load();
  }

  return (
    <section className="mt-6" aria-labelledby={head}>
      <p id={head} className="st-label">
        {words.heading}
      </p>
      <button
        type="button"
        className="btn btn-secondary btn-block btn-wrap mt-3 min-h-11 [overflow-wrap:anywhere]"
        aria-expanded={open}
        aria-controls={panel}
        onClick={toggle}
      >
        {open ? words.hide : words.show}
      </button>
      {/* Kept on the page whether or not the products are shown, so what it says is read out when it changes. */}
      <p role="status" className="st-muted mt-3 text-sm empty:hidden">
        {loading ? words.loading : ""}
      </p>
      {problem ? (
        <p role="alert" className="mt-3 text-sm" style={{ color: "var(--st-text)" }}>
          {problem}
        </p>
      ) : null}
      <div id={panel} hidden={!open}>
        {shown ? (
          <BundleDelivery
            storeName={storeName}
            heading={words.heading}
            showHeading={false}
            missing={shown.missing ? 1 : 0}
            words={{ ...words.bundle, missing: shown.missing }}
            lines={shown.lines.map((line) => ({
              product: { id: line.id, title: line.title, link: line.link },
              download: line.download,
              course: line.course ? { href: line.course } : null,
              keyBox: line.key ? (
                <LicenceKeyBox
                  title={line.title}
                  storeName={storeName}
                  value={line.key.value}
                  revoked={line.key.revoked}
                  waiting={line.key.waiting}
                  words={{ ...words.key, label: line.key.label }}
                />
              ) : null,
            }))}
          />
        ) : null}
      </div>
    </section>
  );
}
