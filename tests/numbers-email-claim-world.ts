// Synthetic stand-ins for the weekly and monthly numbers-email routes (tests/numbers-email-claim.test.ts):
// no network, no provider, no real store. Each export replaces the named lib module's export of the same name.
export const control = {
  folders: ["fixture-store"] as string[],
  numbers: "visitors-0" as "visitors-0" | "visitors-5" | "unknown" | "throws",
  sent: [] as { to: string; subject: string }[],
};
export const NIMBUS_FROM = "Marktmorgen <numbers@example.test>";
export const isSenderConfigured = () => true;
export async function sendEmail(message: { to: string; subject: string }): Promise<boolean> {
  control.sent.push({ to: message.to, subject: message.subject });
  return true;
}
export async function cronAllowed(): Promise<boolean> { return true; }
export async function visitedFolders(): Promise<string[]> { return [...control.folders]; }
export async function storeOf(folder: string) {
  return { handle: folder, name: "Fixture Store", email: "owner@example.test", statsId: "st-fixture", sid: "", currency: "usd", weeklyAi: false, subscriptionActive: true, trialEnds: 0 };
}
export async function weeklySummary(): Promise<string | null> { return null; }
export function aiAvailableFor(): boolean { return false; }
export async function readTeam() { return { members: [] }; }
const day = { visitors: 0, checkouts: 0, sales: 0, cents: 0 };
export async function readStats() {
  if (control.numbers === "throws") throw new Error("synthetic stats read failure");
  return control.numbers === "unknown" ? null : {};
}
export const readsSales = () => false;
export async function readSales() { return null; }
export function studioStats() {
  const visitors = control.numbers === "visitors-5" ? 5 : 0;
  // One day in the month just ended, for the monthly email; the weekly one reads the 7-day total.
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString().slice(0, 10);
  return {
    totals: { d7: { ...day, visitors }, d30: { ...day, visitors }, d90: { ...day, visitors } },
    days: [{ date, visitors, checkouts: 0, sales: 0, cents: 0 }],
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
