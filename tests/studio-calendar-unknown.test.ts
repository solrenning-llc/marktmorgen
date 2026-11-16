/**
 * CX-123 rule 24, app/studio/calendar/page.tsx (MÉDIO). The page reads the team calls
 * this person hosts and takes the time zone their week is written in from them; it hands that zone to the calendar
 * (components/host-calendar.tsx), which sends it with every action, and the server reads a private iCal feed's
 * floating times in it and keeps the busy times it finds (lib/host-calendar.ts, hostSync, readBusyNow).
 *
 * When the store's team setups cannot be read (no reply from Redis), the page reads them as none: it says "None yet"
 * under "Team calls you host here" and hands the calendar "UTC" instead of the host's own zone, so busy times kept
 * from a floating-time feed are read in the wrong zone. Unknown must not become "none" or "UTC".
 *
 * Fixed: when either read fails, whatever the error, the calendar (and so every action that sends a zone) is not
 * shown; the page says, in a status line, that the team calls could not be read and nothing was changed.
 *
 * Synthetic store and Redis (tests/redis-stub.ts); one read is made to fail on purpose.
 */
import { NextRequest } from "next/server";
import StudioCalendarPage from "@/app/studio/calendar/page";
import { HostCalendar } from "@/components/host-calendar";
import { answering } from "./security/next-headers";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import type { CallSetup } from "@/lib/call-setup";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCall, setSubscription, storeForEmail } from "@/lib/store";
import type { Store } from "@/lib/store";
import { writeTeam } from "@/lib/team-booking";
import { UnknownReplyError } from "@/lib/redis-reply";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "calendar-unknown@example.test";
const ZONE = "America/Fortaleza";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = {
  kind: "weekly",
  minutes: 60,
  tz: ZONE,
  weekly: WEEKDAYS,
  noticeHours: 1,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

function find(node: unknown, type: unknown): Node["props"] | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const n = node as Node;
    return n.type === type ? n.props : find(n.props?.children, type);
  }
  return undefined;
}

/** Every text inside an element whose role is the one asked, joined. */
function roleText(node: unknown, role: string): string[] {
  const out: string[] = [];
  const text = (n: unknown): string =>
    typeof n === "string" ? n : Array.isArray(n) ? n.map(text).join("") : n && typeof n === "object" ? text((n as Node).props?.children) : "";
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const props = (n as Node).props;
    if (props?.role === role) out.push(text(props.children).replace(/\s+/g, " ").trim());
    walk(props?.children);
  };
  walk(node);
  return out;
}

async function page(failing: false | (() => Error)) {
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    if (failing && commands.some((c) => c[0] === "HGETALL" && String(c[1]).startsWith("nl:callteam:"))) throw failing();
    return original(commands);
  };
  try {
    answering(new NextRequest("https://marktmorgen.com/studio/calendar", { headers: { cookie } }));
    return await StudioCalendarPage({ searchParams: Promise.resolve({}) });
  } finally {
    redis.pipeline = original;
    answering(null);
  }
}

const HONEST = "Your team calls could not be read just now, so the calendar is not shown and nothing was changed. Reload in a moment.";

async function calendar(failing: boolean) {
  return find(await page(failing ? () => new Error("synthetic: no reply") : false), HostCalendar);
}

async function main() {
  redis.clear();
  await claimHandle(OWNER, "calendarunknown", "Synthetic calendar shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_CalendarUnknown", subscriptionId: "sub_CalendarUnknown", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Team strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(OWNER, made.product.id, weekly);
  const store = (await storeForEmail(OWNER)) as Store;
  await writeTeam(store, made.product.id, {
    mode: "round_robin",
    hosts: [{ email: OWNER, tz: ZONE, weekly: WEEKDAYS, bufferMinutes: 0, noticeHours: 1, dailyCap: 4 }],
    createdAt: "2026-11-01T00:00:00.000Z",
  } as never);

  part("control: the team setups are read");
  const known = await calendar(false);
  is("the calendar is shown", Boolean(known), true);
  is("it is handed the host's own time zone", known?.tz, ZONE);
  is("it lists the team call this person hosts", known?.hosting, ["Team strategy call"]);

  part("the team setups cannot be read");
  const unknown = await calendar(true);
  is("the calendar is never handed a time zone that was not read", Boolean(unknown && unknown.tz !== ZONE), false);
  is("it never says this person hosts no team calls", Boolean(unknown && Array.isArray(unknown.hosting) && unknown.hosting.length === 0), false);

  for (const [name, error] of [
    ["any error", () => new Error("synthetic: no reply")],
    ["an UnknownReplyError", () => new UnknownReplyError("the team setups (synthetic)")],
  ] as const) {
    part(`the team setups cannot be read: ${name}`);
    const tree = await page(error);
    is("no calendar, so no action carries a zone that was not read", Boolean(find(tree, HostCalendar)), false);
    is("the page says so, in a status line", roleText(tree, "status"), [HONEST]);
    is("it is not shown as the calendar settings failing", roleText(tree, "alert"), []);
  }

  part("control: a confirmed setup with no team call for this person");
  await writeTeam(store, made.product.id, null);
  const none = await calendar(false);
  is("the calendar is shown", Boolean(none), true);
  is("it says this person hosts no team calls here", none?.hosting, []);
  is("it is handed the zone the page has always used when nothing here is hosted", none?.tz, "UTC");
  is("no could-not-be-read line", roleText(await page(false), "status"), []);
  done();
}

void main();
