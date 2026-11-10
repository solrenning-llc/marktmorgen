/**
 * A stand-in world for tests/submission-studio.test.ts (750 [CD1] unit 4): the
 * studio's access, the creator's course and the store's studio requests, each
 * writing down what it was asked, in order. lib/submission-store.ts and
 * lib/submission-rules.ts are the real ones, on the in-memory Redis.
 */
export const FOLDER = "0123456789abcdef0123456789abcdef";
export const COURSE = "course0001ab";
export const LESSONS = ["lesson0001ab", "lesson0002ab"];
export const STORE = {
  handle: "shop",
  name: "Shop",
  sid: "submission-studio-0",
  statsId: "c".repeat(32),
  email: "owner@example.test",
  tier: "creator" as const,
  subscriptionActive: true,
  subscriptionId: "sub_x",
  trialEnds: 0,
  planEndedAt: "",
};
export const state = { access: true, allowance: true, listing: "course" as "course" | "none" | "unknown", events: [] as string[] };
export function resetWorld(): void {
  Object.assign(state, { access: true, allowance: true, listing: "course" });
  state.events.length = 0;
}
const refused = () => Response.json({ ok: false, error: "forbidden" }, { status: 403 });
// lib/studio-route.ts
export async function jsonAccess() {
  state.events.push("access");
  return state.access ? { email: "owner@example.test", store: STORE, ref: "owner@example.test", role: "owner" } : refused();
}
// lib/store-request.ts
export async function guardStoreWrite(request: Request) {
  state.events.push("access");
  if (!state.access) return { ok: false as const, response: refused() };
  return { ok: true as const, email: "owner@example.test", ref: "owner@example.test", store: STORE, role: "owner", body: (await request.json()) as Record<string, unknown> };
}
export const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
// lib/catalog.ts
export async function readListingExactly(_store: unknown, id: string) {
  state.events.push("read:listing");
  if (state.listing === "unknown") return "unknown" as const;
  return id === "prod1" && state.listing === "course" ? { id: "prod1", title: "Strong in 30 Days", course: { id: COURSE } } : null;
}
// lib/course.ts
const course = { id: COURSE, modules: [{ id: "unit1", lessons: LESSONS.map((id, i) => ({ id, title: `Lesson ${i + 1}` })) }] };
export async function readCourse(id: string) {
  state.events.push("read:course");
  return id === COURSE ? course : null;
}
export function findLesson(_course: unknown, lessonId: string) {
  const lesson = course.modules[0].lessons.find((l) => l.id === lessonId);
  return lesson ? { lesson, unit: course.modules[0] } : null;
}
// lib/store.ts
export const storeFolder = async () => FOLDER;
export const storeRef = () => "owner@example.test";
// Read by lib/auth.ts (through lib/handle-prefill.ts), which the buyer's reply email loads for its address checks (unit 6).
export const normaliseHandle = (raw: string) => raw.trim().replace(/^@+/, "").toLowerCase();
export const newAddressProblem = () => null;
// lib/store-allowance.ts
export async function takeAllowance(_store: unknown, kind: string, n = 1) {
  state.events.push(`allowance:${kind}:${n}`);
  return state.allowance ? { ok: true as const } : { ok: false as const, reason: "used" as const, message: "Your plan's studio requests for this month are used up." };
}
