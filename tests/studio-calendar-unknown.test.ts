/**
 * CX-123 rule 24, app/studio/calendar/page.tsx (MÉDIO, proof only: not fixed here). The page reads the team calls
 * this person hosts and takes the time zone their week is written in from them; it hands that zone to the calendar
 * (components/host-calendar.tsx), which sends it with every action, and the server reads a private iCal feed's
 * floating times in it and keeps the busy times it finds (lib/host-calendar.ts, hostSync, readBusyNow).
 *
 * When the store's team setups cannot be read (no reply from Redis), the page reads them as none: it says "None yet"
 * under "Team calls you host here" and hands the calendar "UTC" instead of the host's own zone, so busy times kept
 * from a floating-time feed are read in the wrong zone. Unknown must not become "none" or "UTC".
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

async function calendar(failing: boolean) {
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    if (failing && commands.some((c) => c[0] === "HGETALL" && String(c[1]).startsWith("nl:callteam:"))) throw new Error("synthetic: no reply");
    return original(commands);
  };
  try {
    answering(new NextRequest("https://marktmorgen.com/studio/calendar", { headers: { cookie } }));
    return find(await StudioCalendarPage({ searchParams: Promise.resolve({}) }), HostCalendar);
  } finally {
    redis.pipeline = original;
    answering(null);
  }
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
  done();
}

void main();
