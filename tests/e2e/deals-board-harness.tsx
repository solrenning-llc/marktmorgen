/**
 * The deals board alone in a browser page, for tests/e2e/deals-board-focus.mjs
 * (635 [GL3], AAA review): the real component, with synthetic deals and a
 * stand-in for /api/store/crm kept in the page. A refresh draws the board
 * again from what the stand-in holds, as router.refresh() does in the studio.
 * Nothing leaves the page: no server, no store, no real person.
 */
import { use, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DealsBoard } from "@/components/deals-board";
import type { CrmField, Deal, Pipeline } from "@/lib/crm-rules";

type World = { deals: Deal[]; versions: Record<string, string>; pipelines: Pipeline[]; fields: CrmField[]; viewOnly?: string[] };
type Forced = { status: number; body: unknown };
type Harness = { world: World; writes: Record<string, unknown>[]; next: Forced | null; delay: number; refreshDelay: number; requestedEpoch: number; mountedEpoch: number; refresh: () => void; mount: (world: World) => number };

/** The page's own handle on the harness, read by tests/e2e/deals-board-focus.mjs as page.harness. */
const page = window as unknown as Window & { harness: Harness };

const version = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The stand-in for /api/store/crm: the deal and undeal actions as the route answers them (versions, 409 crm_conflict), and a forced answer when a check sets one. */
async function crm(body: Record<string, unknown>): Promise<Response> {
  const h = page.harness;
  h.writes.push(body);
  await new Promise((resolve) => setTimeout(resolve, h.delay));
  if (h.next) {
    const forced = h.next;
    h.next = null;
    return answer(forced.body, forced.status);
  }
  const w = h.world;
  if (body.action === "undeal") {
    if (!w.deals.some((d) => d.id === body.id)) return answer({ ok: false, error: "unknown" }, 404);
    w.deals = w.deals.filter((d) => d.id !== body.id);
    return answer({ ok: true });
  }
  if (body.action === "deal") {
    const raw = (body.deal ?? {}) as Partial<Deal>;
    if (raw.id) {
      const existing = w.deals.find((d) => d.id === raw.id);
      if (!existing) return answer({ ok: false, error: "unknown" }, 404);
      if (body.version !== w.versions[raw.id]) return answer({ ok: false, error: "crm_conflict", current: { deal: existing, version: w.versions[raw.id] } }, 409);
      const changed = { ...existing, ...raw, updatedAt: existing.updatedAt + 1 };
      w.deals = w.deals.map((d) => (d.id === raw.id ? changed : d));
      w.versions = { ...w.versions, [raw.id]: version() };
      return answer({ ok: true });
    }
    const id = "n" + version().slice(0, 9);
    w.deals = [...w.deals, { id, title: String(raw.title ?? ""), email: String(raw.email ?? ""), cents: Number((raw as { cents?: number }).cents ?? 0), stage: String(raw.stage ?? ""), note: String(raw.note ?? ""), nextAction: String(raw.nextAction ?? ""), dueDate: String(raw.dueDate ?? ""), assignee: String(raw.assignee ?? ""), createdAt: 1, updatedAt: 1 } as Deal];
    w.versions = { ...w.versions, [id]: version() };
    return answer({ ok: true });
  }
  return answer({ ok: true });
}

const pageFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  if (!String(input).includes("/api/store/crm")) return pageFetch(input, init);
  return crm(JSON.parse(String(init?.body ?? "{}")));
};

/**
 * A refresh takes `refreshDelay` ms, as the studio's router.refresh() waits for
 * the server: the board suspends inside the board's own transition, so its
 * "refreshing" state lasts as long as it does in the studio.
 */
function Board({ epoch }: { epoch: number }) {
  const [loading, setLoading] = useState<Promise<void> | null>(null);
  if (loading) use(loading);
  useLayoutEffect(() => {
    page.harness.refresh = () => setLoading(new Promise((resolve) => setTimeout(resolve, page.harness.refreshDelay)));
    page.harness.mountedEpoch = epoch;
  }, [epoch]);
  const w = page.harness.world;
  return <DealsBoard deals={[...w.deals]} versions={{ ...w.versions }} stages={w.pipelines.flatMap((p) => p.stages)} pipelines={w.pipelines} pipelineMax={3} viewOnly={w.viewOnly} fields={w.fields} currency="usd" assignees={["owner@example.test"]} today="2026-11-04" />;
}

const root = createRoot(document.getElementById("root")!);
page.harness = {
  world: { deals: [], versions: {}, pipelines: [], fields: [] },
  writes: [],
  next: null,
  delay: 60,
  refreshDelay: 0,
  requestedEpoch: 0,
  mountedEpoch: 0,
  refresh: () => {},
  mount(world: World) {
    this.world = world;
    this.writes = [];
    this.requestedEpoch += 1;
    root.render(<Board key={this.requestedEpoch} epoch={this.requestedEpoch} />);
    return this.requestedEpoch;
  },
};
