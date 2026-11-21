/**
 * The "Grow your sales" card's switch alone in a browser page, for
 * tests/e2e/sales-lever-switch-focus.mjs (752 [CD3]; Codex X6's MEDIUM on
 * #3563): the real component (components/sales-lever-switch.tsx), its
 * control built by the real rules from a synthetic store, and a stand-in for
 * /api/store/recovery kept in the page. Nothing leaves the page: no server,
 * no store, no real person.
 */
import { createRoot } from "react-dom/client";
import { SalesLeverSwitch } from "@/components/sales-lever-switch";
import { leverToggle, type LeverSwitch } from "@/lib/sales-lever-toggle-rules";

type Harness = { writes: Record<string, unknown>[]; next: unknown[]; delay: number; render: (on: boolean) => void };

/** The page's own handle on the harness, read by tests/e2e/sales-lever-switch-focus.mjs as window.harness. */
const page = window as unknown as Window & { harness: Harness };

/** The recovery switch as the studio builds it for a synthetic store whose reminders are `on`. */
function control(on: boolean): LeverSwitch {
  const made = leverToggle("recovery", {
    store: { name: "Synthetic Shop", stripeAccountId: "acct_synthetic", recovery: { enabled: on, address: "100 Synthetic Way, Testville, CA 90000" } },
    role: "owner",
    addOn: true,
  });
  if (made.kind !== "toggle") throw new Error("the synthetic store gives no switch");
  return made;
}

const pageFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  if (!String(input).includes("/api/store/recovery")) return pageFetch(input, init);
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  page.harness.writes.push(body);
  await new Promise((resolve) => setTimeout(resolve, page.harness.delay));
  // A forced answer when a check queued one; else the route's own: ok, echoing the saved setting.
  const reply = page.harness.next.length ? page.harness.next.shift() : { ok: true, recovery: { enabled: body.enabled, address: body.address } };
  return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
};

const root = createRoot(document.getElementById("root")!);
page.harness = {
  writes: [],
  next: [],
  /** How long the stand-in takes to answer, in ms; a check that moves the focus meanwhile makes it long. */
  delay: 40,
  /** Draws the card from the saved store, as the studio does on every refresh; the switch keeps its own view. */
  render(on: boolean) {
    root.render(<SalesLeverSwitch control={control(on)} states={{ on: "Reminders are on", off: "Reminders are off" }} />);
  },
};
