/**
 * Where a store's forms and their answers are kept (lib/forms.ts has the
 * rules).
 *
 *   nl:forms:<statsId>             hash  form id -> the form
 *   nl:form:r:<statsId>:<form id>  list  its responses, newest first, KEPT_RESPONSES at most;
 *                                         a scored quiz's total and category scores are kept
 *                                         inside each response, so they go wherever it goes
 *
 * Under the store's own stats id, so they move with the store, as its
 * affiliates and its pages do.
 *
 * The answers take room in the store's data room (lib/store-data.ts), one
 * slot a form, before they are written: an answer that does not fit is not
 * kept (DataRoomError), and the oldest one let go past KEPT_RESPONSES gives
 * its room back. The forms themselves are few and bounded (MAX_FORMS).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { type DataStore, giveData, needData, noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { UnknownReply, exactReplies, plainList } from "@/lib/redis-exact";
import { type FormDef, type FormResponse, FORM_RESPONSE_ID, FORM_ID, KEPT_RESPONSES, MAX_FORMS, parseForm } from "@/lib/forms";

const formsKey = (statsId: string) => `nl:forms:${statsId}`;
const responsesKey = (statsId: string, formId: string) => `nl:form:r:${statsId}:${formId}`;

/** Every form of a store, newest change first. */
export async function readForms(statsId: string | null): Promise<FormDef[]> {
  if (!statsId || !isRedisConfigured()) return [];
  // Read exactly (rule 24): a reply cut short or of another shape throws, never "this store has no forms", which left
  // a person's answers out of their data copy and wrote no forms into the store's export.
  const list = stringList(repliesFor(await redisPipeline([["HVALS", formsKey(statsId)]]), 1)?.[0]);
  if (!list) throw new UnknownReplyError("a store's forms");
  return list
    .map((value) => {
      try {
        return parseForm(JSON.parse(String(value)));
      } catch {
        return null;
      }
    })
    .filter((f): f is FormDef => f !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** One form, or null. */
export async function readForm(statsId: string | null, id: string): Promise<FormDef | null> {
  if (!statsId || !FORM_ID.test(id) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["HGET", formsKey(statsId), id]]);
  if (typeof raw !== "string") return null;
  try {
    return parseForm(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Checks capacity before a multi-step setup; writeForm still checks concurrent changes. */
export async function canAddForms(statsId: string, amount: number): Promise<boolean> {
  if (!statsId || !isRedisConfigured() || !Number.isSafeInteger(amount) || amount < 0) throw new Error("Form capacity unavailable");
  const results = await redisPipeline([["HLEN", formsKey(statsId)]]);
  if (results.length !== 1) throw new Error("Form capacity unavailable");
  const raw = results[0];
  const count = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Form capacity unavailable");
  return count + amount <= MAX_FORMS;
}

/** Capacity is shared by manual editing and guided setup in one Redis operation. */
export const SAVE_FORM = `-- marktmorgen:form-save:v1
if redis.call("HEXISTS", KEYS[1], ARGV[1]) == 0 and redis.call("HLEN", KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
return 1`;

/** Saves a form; existing forms remain editable at capacity. Unknown writes require review. */
export async function writeForm(statsId: string, form: FormDef): Promise<boolean> {
  const results = await redisPipeline([["EVAL", SAVE_FORM, 1, formsKey(statsId), form.id, JSON.stringify(form), MAX_FORMS]]);
  if (results.length !== 1 || (results[0] !== 0 && results[0] !== 1)) throw new Error("Form save could not be confirmed");
  return results[0] === 1;
}

/** Removes a form and every answer kept for it, and gives back the answers' room. */
export async function dropForm(statsId: string, id: string, room: DataStore): Promise<boolean> {
  const [removed] = await redisPipeline([
    ["HDEL", formsKey(statsId), id],
    ["DEL", responsesKey(statsId, id)],
  ]);
  await giveData(room, [{ slot: ANSWERS_SLOT(id), bytes: 0, set: true }]);
  return Number(removed) === 1;
}

const ANSWERS_SLOT = (formId: string) => `fr:${formId}`;

/** One response kept, the newest first, and the ones past ARGV[2] let go, answered: what was really let go. */
export const KEEP_FORM_RESPONSE = `-- marktmorgen:form-keep:v1
redis.call("LPUSH", KEYS[1], ARGV[1])
local out = {}
while redis.call("LLEN", KEYS[1]) > tonumber(ARGV[2]) do
  table.insert(out, redis.call("RPOP", KEYS[1]))
end
return out`;

/**
 * Keeps one response, the newest first, and lets the oldest go past
 * KEPT_RESPONSES. The room is taken first from what is read (the new one
 * less the oldest that should go), then set right from what the keep really
 * let go, in one script, so a deletion of the person's responses at the same
 * time, or another response, never leaves the room counting less than is kept.
 */
export async function addResponse(statsId: string, formId: string, response: FormResponse, room: DataStore): Promise<void> {
  const json = JSON.stringify(response);
  const [kept, oldest] = await redisPipeline([["LLEN", responsesKey(statsId, formId)], ["LINDEX", responsesKey(statsId, formId), -1]]);
  const guessed = Number(kept) >= KEPT_RESPONSES && typeof oldest === "string" ? dataBytes([oldest], 1) : 0;
  const charged = dataBytes([json], 1) - guessed;
  await needData(room, [{ slot: ANSWERS_SLOT(formId), bytes: charged }]);
  const [gone] = await redisPipeline([["EVAL", KEEP_FORM_RESPONSE, 1, responsesKey(statsId, formId), json, KEPT_RESPONSES]]);
  const dropped = (Array.isArray(gone) ? gone : []).reduce<number>((sum, raw) => sum + (typeof raw === "string" ? dataBytes([raw], 1) : 0), 0);
  const off = dataBytes([json], 1) - dropped - charged;
  if (off > 0) await noteData(room, [{ slot: ANSWERS_SLOT(formId), bytes: off }]);
  else if (off < 0) await giveData(room, [{ slot: ANSWERS_SLOT(formId), bytes: -off }]);
}

function parseResponse(raw: unknown): FormResponse | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<FormResponse>;
    if (typeof value.at !== "number" || !value.answers || typeof value.answers !== "object") return null;
    const score = typeof value.score === "number" && Number.isInteger(value.score) && value.score >= 0 ? value.score : null;
    const scores = value.scores && typeof value.scores === "object" && !Array.isArray(value.scores) ? Object.fromEntries(Object.entries(value.scores).filter(([k, v]) => /^[a-z0-9]{6}$/.test(k) && Number.isInteger(v) && (v as number) >= 0)) : null;
    return {
      ...(typeof value.id === "string" && FORM_RESPONSE_ID.test(value.id) ? { id: value.id } : {}),
      at: value.at,
      page: typeof value.page === "string" ? value.page : "",
      answers: value.answers,
      outcome: typeof value.outcome === "string" ? value.outcome : "",
      joined: value.joined === true,
      // A scored quiz's total and categories, kept with the answers and deleted with them (forgetFormsPerson).
      ...(score !== null ? { score, ...(scores ? { scores: scores as Record<string, number> } : {}) } : {}),
    };
  } catch {
    return null;
  }
}

/** A form's responses, newest first, and how many are kept in all. */
export async function readResponses(statsId: string | null, formId: string, limit = KEPT_RESPONSES): Promise<{ responses: FormResponse[]; total: number }> {
  if (!statsId || !FORM_ID.test(formId) || !isRedisConfigured()) return { responses: [], total: 0 };
  const what = "the form responses";
  const [raw, total] = exactReplies(await redisPipeline([
    ["LRANGE", responsesKey(statsId, formId), 0, Math.max(0, Math.min(limit, KEPT_RESPONSES) - 1)],
    ["LLEN", responsesKey(statsId, formId)],
  ]), 2, what);
  const list = plainList(raw);
  if (!list || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) throw new UnknownReply(what);
  const responses = list.map(parseResponse);
  if (responses.some(response => response === null)) throw new UnknownReply(what);
  return {
    responses: responses as FormResponse[],
    total,
  };
}

/** How many responses each of these forms has kept. */
export async function responseCounts(statsId: string | null, ids: string[]): Promise<Record<string, number>> {
  if (!statsId || !ids.length || !isRedisConfigured()) return {};
  const counts = await redisPipeline(ids.map((id) => ["LLEN", responsesKey(statsId, id)]));
  return Object.fromEntries(ids.map((id, i) => [id, Number(counts[i]) || 0]));
}

/**
 * Removes, from every list of responses given, each response one of whose
 * answers is this address (ARGV[1], lower case), on the Redis side so no
 * response travels. Answers how many went.
 */
export const FORGET_FORM_PERSON = `-- marktmorgen:form-forget:v2
local out = {}
for k = 1, #KEYS do
  local items = redis.call("LRANGE", KEYS[k], 0, -1)
  for _, raw in ipairs(items) do
    local ok, value = pcall(cjson.decode, raw)
    local hit = false
    if ok and type(value) == "table" and type(value.answers) == "table" then
      for _, answer in pairs(value.answers) do
        if type(answer) == "string" and string.lower(string.match(answer, "^%s*(.-)%s*$")) == ARGV[1] then hit = true end
      end
    end
    if hit then
      local n = redis.call("LREM", KEYS[k], 0, raw)
      if n > 0 then
        table.insert(out, k)
        table.insert(out, raw)
        table.insert(out, n)
      end
    end
  end
end
return out`;

/**
 * Deletes every response one person gave to any of the store's forms
 * (lib/person-erasure.ts), and gives back to `room` exactly what each one
 * took when it was kept (addResponse): the script answers each response it
 * removed, by form, with how many times it was there. A reply that is not
 * exactly that throws UnknownReply (lib/redis-exact.ts).
 */
export async function forgetFormsPerson(statsId: string | null, email: string, room?: DataStore): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const what = "the deletion of a person's form responses";
  // Which forms there are, read exactly (Codex G on #2584): the list as asked, every value a form that reads. Only an
  // exact empty list means no forms; a reply in another shape, or a form record that does not read, is not "no
  // responses to delete", so it throws UnknownReply and the erasure is said as incomplete.
  const [listed] = exactReplies(await redisPipeline([["HVALS", formsKey(statsId)]]), 1, `${what} (its forms)`);
  const values = plainList(listed);
  if (!values) throw new UnknownReply(`${what} (its forms)`);
  const forms = values.map((value) => {
    if (typeof value !== "string") throw new UnknownReply(`${what} (its forms)`);
    try {
      const form = parseForm(JSON.parse(value));
      if (form) return form;
    } catch {
      // Falls through to the refusal below.
    }
    throw new UnknownReply(`${what} (its forms)`);
  });
  if (!forms.length) return 0;
  const [reply] = exactReplies(await redisPipeline([["EVAL", FORGET_FORM_PERSON, forms.length, ...forms.map((f) => responsesKey(statsId, f.id)), email.trim().toLowerCase()]]), 1, what);
  // Exactly {form's place, response, times removed} for each: any other shape
  // leaves the deletion unknown (UnknownReply), and nothing is given back.
  const list = plainList(reply);
  if (!list || list.length % 3 !== 0) throw new UnknownReply(what);
  let removed = 0;
  const freed = new Map<string, number>();
  for (let i = 0; i < list.length; i += 3) {
    const [at, raw, n] = [list[i], list[i + 1], list[i + 2]];
    const form = typeof at === "number" && Number.isInteger(at) ? forms[at - 1] : undefined;
    if (!form || typeof raw !== "string" || typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) throw new UnknownReply(what);
    removed += n;
    freed.set(form.id, (freed.get(form.id) ?? 0) + dataBytes([raw], 1) * n);
  }
  if (room && freed.size) await giveData(room, [...freed].map(([id, bytes]) => ({ slot: ANSWERS_SLOT(id), bytes })));
  return removed;
}

/**
 * Finds one kept response by its id inside Redis (ARGV[1], 32 hex digits) and
 * answers only that response's text, or nil: the list is read there in blocks
 * of 50 up to ARGV[2] (KEPT_RESPONSES), newest first, as readResponses reads
 * it, and the first response written with that id is the one (addResponse
 * writes JSON.stringify, so its id stands as "id":"..."). A response whose
 * words hold the id but that is another one is passed over; one that holds it
 * and does not decode is answered as it is, for the reader to refuse.
 */
export const FIND_FORM_RESPONSE = `-- marktmorgen:form-find:v1
local needle = '"id":"' .. ARGV[1] .. '"'
local last = tonumber(ARGV[2]) - 1
local from = 0
while from <= last do
  local to = math.min(from + 49, last)
  local items = redis.call("LRANGE", KEYS[1], from, to)
  for _, raw in ipairs(items) do
    if string.find(raw, needle, 1, true) then
      local ok, value = pcall(cjson.decode, raw)
      if not ok or type(value) ~= "table" or value.id == ARGV[1] then return raw end
    end
  end
  if #items < to - from + 1 then return false end
  from = to + 1
end
return false`;

/**
 * One response to a form by its id, or null when it is not kept (a confirmed
 * nil). Found in Redis (FIND_FORM_RESPONSE), so only that response travels,
 * never every response kept. A reply in any other shape, or a text that does
 * not read as that response, throws UnknownReply (rule 24): never "gone".
 */
export async function readResponse(statsId: string | null, formId: string, responseId: string): Promise<FormResponse | null> {
  if (!statsId || !FORM_ID.test(formId) || !FORM_RESPONSE_ID.test(responseId) || !isRedisConfigured()) return null;
  const what = "a form response";
  const [raw] = exactReplies(await redisPipeline([["EVAL", FIND_FORM_RESPONSE, 1, responsesKey(statsId, formId), responseId, KEPT_RESPONSES]]), 1, what);
  if (raw === null) return null;
  const response = parseResponse(raw);
  if (!response || response.id !== responseId) throw new UnknownReply(what);
  return response;
}
