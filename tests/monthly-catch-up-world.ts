import { storeIdCommand } from "@/lib/store";
import { store as summaryRedis } from "./redis-stub";
// Synthetic stand-ins for the monthly numbers-email route (tests/monthly-summary-catch-up.test.ts): no network, no
// provider, no real store. Unlike tests/numbers-email-claim-world.ts, the stores visited and the visitors read are
// kept by month, so a run can be asked about more than the month just ended (#3995).
export const control = {
  /** The stores visited in each month ("2027-01"). */
  folders: {} as Record<string, string[]>,
  /** Each month's visitors on its 15th. */
  visitors: {} as Record<string, number>,
  sent: [] as { to: string; subject: string }[],
};
export const NIMBUS_FROM = "Marktmorgen <numbers@example.test>";
export const isSenderConfigured = () => true;
export async function sendEmail(message: { to: string; subject: string }): Promise<boolean> {
  control.sent.push({ to: message.to, subject: message.subject });
  return true;
}
export const sendEmailPinned = (message: Parameters<typeof sendEmail>[0]) => sendEmail(message);
export async function cronAllowed(): Promise<boolean> { return true; }
/** The month key lib/traffic.ts uses, "2027-01" for any day of January. */
export async function visitedFolders(month = ""): Promise<string[]> { return [...(control.folders[month.slice(0, 7)] ?? [])]; }
export async function storeOf(folder: string) {
  return { handle: folder, name: "Fixture Store", email: "owner@example.test", statsId: "b".repeat(32), sid: "f".repeat(32), currency: "usd", weeklyAi: false, subscriptionActive: true, trialEnds: 0 };
}
export async function weeklySummary(): Promise<string | null> { return null; }
export function aiAvailableFor(): boolean { return false; }
export async function readTeam() { return { members: [] }; }
export async function readTeamMembers() { return []; }
const day = { visitors: 0, checkouts: 0, sales: 0, cents: 0 };
export async function readStats() { return {}; }
export const readsSales = () => false;
export async function readSales() { return null; }
export function studioStats() {
  const days = Object.entries(control.visitors)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, visitors]) => ({ date: `${month}-15`, visitors, checkouts: 0, sales: 0, cents: 0 }));
  return {
    totals: { d7: { ...day }, d30: { ...day }, d90: { ...day } },
    days,
    channelDays: {},
    channels: { d7: [], d30: [], d90: [] },
    products: [],
    heard: [],
    searchMisses: [],
    reach: [],
    sales: "none",
    currency: "usd",
  };
}
export async function sourcesToday() { return []; }
export async function viewsBefore() { return 0; }

/** Live synthetic identity, seeded by each test reset. */
export function seedMonthlyStore(): void { summaryRedis.run(["SET", storeIdCommand("f".repeat(32))[1], "owner@example.test"]); }
