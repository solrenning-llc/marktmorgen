export let available = true;
export let response: unknown[] | null = null;
export let failure = false;
export const calls: (string | number)[][][] = [];
export const ledger = new Map<string, Map<string, string>>();
export const opened = new Set<string>();
export function reset() { available = true; response = null; failure = false; calls.length = 0; ledger.clear(); opened.clear(); }
export const isRedisConfigured = () => available;
export function seed(key: string, review: string, policy: string, funded = {creator:1,pro:0,scale:0,trial:0,setup:0,ended:0}) { ledger.set(key, new Map([['review', review], ['policy', policy], ['company', '0'], ...Object.entries(funded).map(([tier,count]): [string,string] => ['slots:'+tier,String(count)])])); }
export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  calls.push(commands);
  if (failure) throw new Error('Redis unavailable');
  if (response) return response;
  // Contract double only: the production Lua runs against real Redis in scripts/test_ai_spend_redis.py.
  if (commands.length === 2 && commands[0][0] === 'EVAL' && commands[0][2] === 2) return [openLedger(commands[0]), reserve(commands[1])];
  if (commands.length !== 1) throw new Error('Expected one atomic reservation');
  return [reserve(commands[0])];
}
const TIERS = ['creator', 'pro', 'scale', 'trial', 'setup', 'ended'];
const parseAmount = (s: string | undefined) => s !== undefined && /^(0|[1-9][0-9]*)$/.test(s) && Number(s) <= 1e12 ? Number(s) : NaN;
function openLedger(cmd: (string | number)[]): number {
  const [, , , key, marker, review, policy, ...counts] = cmd.map(String);
  const funded = counts.map(parseAmount);
  if (funded.length !== 6 || funded.some(n => !Number.isSafeInteger(n))) return 0;
  const hash = ledger.get(key);
  if (!hash) {
    if (opened.has(marker)) return 0;
    opened.add(marker);
    ledger.set(key, new Map([['review', review], ['policy', policy], ['company', '0'], ...TIERS.flatMap((tier, i): [string, string][] => [['slots:' + tier, String(funded[i])], ['funded:' + tier, String(funded[i])]])]));
    return 1;
  }
  if (hash.get('review') !== review) return 0;
  if (hash.get('policy') === policy) return 1;
  if (!Number.isSafeInteger(parseAmount(hash.get('company')))) return 0;
  const slots: number[] = [];
  for (const [i, tier] of TIERS.entries()) {
    const was = parseAmount(hash.get('funded:' + tier)), left = parseAmount(hash.get('slots:' + tier));
    if (!Number.isSafeInteger(was) || !Number.isSafeInteger(left) || left > was) return 0;
    slots.push(Math.max(0, funded[i] - (was - left)));
  }
  TIERS.forEach((tier, i) => { hash.set('slots:' + tier, String(slots[i])); hash.set('funded:' + tier, String(funded[i])); });
  hash.set('policy', policy);
  return 1;
}
function reserve(cmd: (string | number)[]): number {
  const [, , keys, key, review, field, amount, storeLimit, companyLimit, policy, tier, funded] = cmd;
  if (cmd[0] !== 'EVAL' || keys !== 1) throw new Error('Expected one atomic reservation');
  const hash = ledger.get(String(key));
  if (!hash || hash.get('review') !== review || hash.get('policy') !== policy) return 0;
  const parse = parseAmount;
  const company = parse(hash.get('company'));
  // v2 (R32 finding 1): a plan switched inside the window moves the field's one total under the current tier.
  if (!TIERS.includes(String(tier))) return 0;
  const scopeField = 'tier:' + field, scope = hash.get(scopeField);
  const hasScope = hash.has(scopeField);
  if (hasScope && (!TIERS.includes(String(scope)) || !hash.has(String(field)))) return 0;
  if (!hasScope && hash.has(String(field))) return 0;
  if (hash.has(String(field)) && !Number.isSafeInteger(parse(hash.get(String(field))))) return 0;
  const heldField = 'held:' + tier + ':' + field, held = hash.get(heldField);
  if (hash.has(heldField) && (held !== '1' || !hasScope)) return 0;
  const switched = hasScope && scope !== tier;
  const leftField = switched ? 'held:' + scope + ':' + field : null;
  if (leftField && hash.has(leftField) && hash.get(leftField) !== '1') return 0;
  const claim = !hasScope || (switched && !hash.has(heldField));
  const slots = parse(hash.get('slots:' + tier));
  if (!Number.isSafeInteger(slots) || slots > Number(funded) || (claim && slots <= 0)) return 0;
  const used = hash.has(String(field)) ? parse(hash.get(String(field))) : 0;
  if (!Number.isSafeInteger(company) || !Number.isSafeInteger(used) || used > company || used > Number(storeLimit) || Number(amount) > Number(storeLimit) - used || Number(amount) > Number(companyLimit) - company) return 0;
  if (claim) hash.set('slots:' + tier, String(slots - 1));
  if (leftField) hash.set(leftField, '1');
  if (!hasScope || switched) hash.set(scopeField, String(tier));
  hash.set(String(field), String(used + Number(amount)));hash.set('company', String(company + Number(amount)));return 1;
}
export function settings(value: { available?: boolean; response?: unknown[] | null; failure?: boolean }) { if(value.available !== undefined)available=value.available;if(value.response !== undefined)response=value.response;if(value.failure !== undefined)failure=value.failure; }
