"use client";

import { type FormEvent, useId, useState, useSyncExternalStore } from "react";
import { BundleDelivery } from "@/components/bundle-delivery";
import { LicenceKeyBox } from "@/components/licence-key-box";
import { useOrdersShared } from "@/components/orders-shared";
import { LINK_SHOWN } from "@/lib/buyer-orders-rules";

/** Whether the page runs its script never changes once read. */
const noChange = () => () => {};

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

/**
 * A bundle on the list of purchases: its name, and a button that shows its
 * products (the WAI-ARIA disclosure pattern once the page runs its script: the
 * button's name stays the same, aria-expanded says whether they are shown,
 * focus stays on it, and the products follow it). They are read only when
 * asked for, from app/api/store/orders/bundle, a request that pays for itself
 * before anything is read (lib/buyer-orders.ts, bundleFor), so an opening of
 * the list never draws every product of every bundle (C3-80). Shown once,
 * they stay: hiding and showing them again reads nothing more.
 *
 * Without JavaScript the same button sends its form: the list's page draws
 * this bundle's products on a page of their own (`bundle`), paid for the same
 * way (app/[handle]/orders/page.tsx). Only what differs from one bundle to
 * the next comes as props; the words and the address are the list's
 * (components/orders-shared.tsx).
 */
export function OrdersBundle({ reference, item, label, heading }: { reference: string; item: string; label: string; heading: string }) {
  const shared = useOrdersShared();
  const { words } = shared;
  const panel = useId();
  const head = useId();
  // False in the HTML and while the page takes over, true once it runs: only then is the button a disclosure.
  const ready = useSyncExternalStore(noChange, () => true, () => false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState("");
  const [shown, setShown] = useState<{ lines: OrdersBundleLine[]; missing: string | null } | null>(null);

  async function load() {
    setLoading(true);
    setProblem("");
    let said = words.failed;
    try {
      const address = `/api/store/orders/bundle?${new URLSearchParams({ handle: shared.handle, token: shared.token, ref: reference, item })}`;
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

  function toggle(event: FormEvent) {
    event.preventDefault();
    const next = !open;
    setOpen(next);
    if (next && !shown && !loading) void load();
  }

  return (
    <section className="mt-6" aria-labelledby={head}>
      <p id={head} className="st-label">
        {heading}
      </p>
      <form method="get" action={`/@${shared.handle}/orders`} onSubmit={toggle}>
        <input type="hidden" name="token" value={shared.token} />
        <input type="hidden" name="bundle" value={`${reference}:${item}`} />
        <button
          type="submit"
          className="btn btn-secondary btn-block btn-wrap mt-3 min-h-11 [overflow-wrap:anywhere]"
          aria-expanded={ready ? open : undefined}
          aria-controls={ready ? panel : undefined}
        >
          {label}
        </button>
      </form>
      {/* Always on the page, so what it says is read out when it changes; out of sight while it says nothing. */}
      <p role="status" className={loading ? "st-muted mt-3 text-sm" : "sr-only"}>
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
            storeName={shared.storeName}
            heading={heading}
            showHeading={false}
            shownLink={LINK_SHOWN}
            missing={shown.missing ? 1 : 0}
            words={{ ...words.bundle, missing: shown.missing }}
            lines={shown.lines.map((line) => ({
              product: { id: line.id, title: line.title, link: line.link },
              download: line.download,
              course: line.course ? { href: line.course } : null,
              keyBox: line.key ? (
                <LicenceKeyBox
                  title={line.title}
                  storeName={shared.storeName}
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
