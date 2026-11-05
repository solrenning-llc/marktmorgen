export const state = { partial: false, connected: true, formsFail: false };
export const BODIES_PER_READ = 500;
export const EXPORT_PAGES = 50;
export async function readAllListings() { return [{ id: "fixture-product", title: "A sample", course: { id: "fixture-course" } }]; }
export async function readCourses() { return new Map([["fixture-course", { id: "fixture-course", modules: [{ lessons: [{ id: "fixture-lesson" }] }] }]]); }
export async function readAllBodies() { return new Map([["fixture-course", { "fixture-lesson": "A lesson's full text." }]]); }
export async function listAsCsv() { return '"email"\n"buyer@example.test"'; }
export async function listSize() { return { total: 1 }; }
export async function dataUsed() { return { used: 512 }; }
export async function readForms() { if (state.formsFail) throw new Error("synthetic unread form"); return [{ id: "fixture-form" }]; }
export async function readResponses() { return { responses: [{ at: 1, answers: { sample: "A synthetic answer" } }], total: 1 }; }
export async function readAbouts() { return ["A product's full description."]; }
export async function readPages() { return [{ title: "A page" }]; }
export function readsSales() { return state.connected; }
export async function salesCsv() { return { csv: '"paid_with"\n"stripe"', partial: state.partial }; }
export async function allPosts() { return ["fixture-post"]; }
export async function readPosts() { return [{ id: "fixture-post", text: "A synthetic post" }]; }
export async function readThanksNotes() { return ["Thank you."]; }
