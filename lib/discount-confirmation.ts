import type { CodeDuration, CodeMinimum, DiscountCode, Off } from "@/lib/discount";

const record = (raw: unknown): raw is Record<string, unknown> => Boolean(raw && typeof raw === "object" && !Array.isArray(raw));
const own = (raw: Record<string, unknown>, keys: string[]) => keys.every(key => Object.hasOwn(raw,key));
const count = (raw: unknown): raw is number => typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
const date = (raw: unknown) => raw === null || (count(raw) && raw <= 8_640_000_000_000);

function readOff(raw: unknown): Off | null | false {
 if(raw === null)return null;
 if(!record(raw) || !Object.hasOwn(raw,"kind"))return false;
 if(raw.kind === "percent" && Object.hasOwn(raw,"percent") && typeof raw.percent === "number" && Number.isFinite(raw.percent) && raw.percent > 0 && raw.percent <= 100)return {kind:"percent",percent:raw.percent};
 if(raw.kind === "amount" && own(raw,["cents","currency"]) && count(raw.cents) && raw.cents > 0 && typeof raw.currency === "string" && /^[a-zA-Z]{3}$/.test(raw.currency))return {kind:"amount",cents:raw.cents,currency:raw.currency};
 return false;
}

/** A minimum order: absent or null reads as none; anything else must be a real amount and currency. */
function readMinimum(raw: unknown): CodeMinimum | null | false {
 if(raw === undefined || raw === null)return null;
 if(!record(raw) || !own(raw,["cents","currency"]) || !count(raw.cents) || raw.cents <= 0 || typeof raw.currency !== "string" || !/^[a-z]{3}$/i.test(raw.currency))return false;
 return {cents:raw.cents,currency:raw.currency.toLowerCase()};
}

/** How long on a membership: absent or null is not known; anything else must be one of Stripe's three. */
function readDuration(raw: unknown): CodeDuration | null | false {
 if(raw === undefined || raw === null)return null;
 if(!record(raw) || !Object.hasOwn(raw,"kind"))return false;
 if(raw.kind === "once" || raw.kind === "forever")return {kind:raw.kind};
 if(raw.kind === "repeating" && Object.hasOwn(raw,"months") && count(raw.months) && raw.months > 0)return {kind:"repeating",months:raw.months};
 return false;
}

/** Exact API evidence only; an unreadable list must never become an empty success. Browser-safe. */
export function readDiscountConfirmation(raw: unknown, httpOk: boolean): DiscountCode[] | null {
 if(!httpOk || !record(raw) || !own(raw,["ok","codes"]) || raw.ok !== true || Object.hasOwn(raw,"error") || !Array.isArray(raw.codes))return null;
 const result: DiscountCode[]=[];const ids=new Set<string>();
 for(const row of raw.codes){
  if(!record(row) || !own(row,["id","code","off","timesRedeemed","maxRedemptions","expiresAt","active"]) || typeof row.id !== "string" || !row.id || ids.has(row.id) || typeof row.code !== "string" || !row.code || typeof row.active !== "boolean" || !count(row.timesRedeemed) || !(row.maxRedemptions === null || (count(row.maxRedemptions) && row.maxRedemptions > 0)) || !date(row.expiresAt))return null;
  const off=readOff(row.off);if(off === false)return null;
  const minimum=readMinimum(row.minimum);const duration=readDuration(row.duration);
  if(minimum === false || duration === false || (Object.hasOwn(row,"firstOrder") && typeof row.firstOrder !== "boolean") || (Object.hasOwn(row,"otherRules") && typeof row.otherRules !== "boolean"))return null;
  ids.add(row.id);
  result.push({id:row.id,code:row.code,off,timesRedeemed:row.timesRedeemed,maxRedemptions:row.maxRedemptions as number|null,expiresAt:row.expiresAt as number|null,active:row.active,minimum,firstOrder:row.firstOrder === true,duration,otherRules:row.otherRules === true});
 }
 return result;
}
