/**
 * A stand-in world for tests/submission-upload.test.ts (750 [CD1] unit 2): the
 * store, its course, the learner's access, the request guards, the buyer's
 * counts and the vault and upload allowance, each writing down what it was
 * asked, in order. lib/submission-store.ts and lib/submission-rules.ts are the
 * real ones, on the in-memory Redis.
 */
const MiB = 1024 * 1024;
export const FOLDER = "0123456789abcdef0123456789abcdef";
export const COURSE = "course0001ab";
export const LESSON = "lesson0001ab";
type Learner = { email: string; scope: "all"; owner: boolean };
export const state = {
  crossSite: false,
  store: { handle: "shop", sid: "submission-route-0", statsId: "c".repeat(32), email: "owner@example.test", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_x", trialEnds: 0, planEndedAt: "" } as Record<string, unknown>,
  found: "store" as "store" | "none" | "unknown",
  hold: true,
  action: true,
  rate: true,
  priceCents: 4_900,
  access: "open" as "open" | "closed" | "ended",
  learner: { email: "ana@example.com", scope: "all", owner: false } as Learner | null,
  budget: true,
  control: true,
  measuredType: "video/mp4",
  events: [] as string[],
};
export function resetWorld(): void {
  Object.assign(state, { crossSite: false, found: "store", hold: true, action: true, rate: true, priceCents: 4_900, access: "open", budget: true, control: true, measuredType: "video/mp4" });
  state.learner = { email: "ana@example.com", scope: "all", owner: false };
  state.store.subscriptionActive = true;
  state.store.trialEnds = 0;
  state.events.length = 0;
}

// lib/request-guard.ts
export const fromAnotherSite = () => state.crossSite;
export const limited = async (request: Request) => request;
export const withinLimit = async (scope: string) => (state.events.push(`limit:${scope}`), state.rate);
// lib/store.ts
export const normaliseHandle = (raw: string) => raw.trim().toLowerCase();
export const storeRef = () => "owner@example.test";
export const storeFolder = async () => FOLDER;
// lib/store-exact.ts
export const storeForHandleExactly = async () => (state.events.push("read:store"), state.found === "store" ? state.store : state.found);
// lib/buyer-actions.ts
/** One public request is written "hold"; more at once, "hold:<units>" (the buyer's list pays its reads by how many there are). */
export const takeBuyerRead = async (_store?: unknown, units = 1) => (state.events.push(units === 1 ? "hold" : `hold:${units}`), state.hold);
export const takeBuyerAction = async () => (state.events.push("action"), state.action);
// lib/catalog.ts
export const readCourseListing = async (_store: unknown, id: string) =>
  (state.events.push("read:listing"), id === "prod1" ? { id: "prod1", priceCents: state.priceCents, course: { id: COURSE } } : null);
// lib/course.ts
const lesson = { id: LESSON };
const unit = { id: "unit1", lessons: [lesson] };
export const readCourse = async (id: string) => (state.events.push("read:course"), id === COURSE ? { id: COURSE, modules: [unit] } : null);
export const findLesson = (_course: unknown, id: string) => (id === LESSON ? { lesson, unit } : null);
export const isOpen = () => true;
// lib/learn.ts
export const courseAccess = async () => {
  state.events.push("read:access");
  if (!state.learner) return { state: "closed", learner: null };
  return state.access === "open" ? { state: "open", learner: state.learner, start: 0 } : { state: state.access, learner: state.learner };
};
export const emailKey = (email: string) => (email.startsWith("ana") ? "a" : "b").repeat(32);
// lib/upload-budget.ts
export const reserveStoreUpload = async () => (state.events.push("budget"), state.budget);
export const reserveUploadControl = async () => (state.events.push("control"), state.control);
// lib/vault-storage.ts and lib/vault.ts
let opened = 0;
export const openReservedVault = async (input: { folder: string; ownerId: string; name: string }) => {
  state.events.push("vault:open");
  opened += 1;
  return { ok: true as const, sessionId: "s", upload: { pathname: `vault/${input.folder}/${input.ownerId}/${String(opened).padStart(16, "0")}-${input.name}`, pieces: 1, pieceBytes: 16 * MiB, multipart: true as const } };
};
export const closeReservedVault = async (pathname: string) => (state.events.push("vault:close"), { ok: true as const, file: { pathname, bytes: 50 * MiB, contentType: state.measuredType } });
export const abortReservedVault = async () => (state.events.push("vault:abort"), true);
export const signPieces = async (_pathname: string, numbers: number[]) => (state.events.push("sign"), numbers.map((number) => ({ number, url: "https://vault.example.test/p", type: null })));
export const deleteVault = async () => (state.events.push("vault:delete"), true);
