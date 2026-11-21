export let configured = true;
export let result: unknown[] = [null];
export let fail = false;
export const commands: (string | number)[][][] = [];
export const isRedisConfigured = () => configured;
/**
 * A single read answers `result` as it is (the admission reads' own shapes). The playback hold (lib/watch.ts,
 * holdPlayback, since 9 November 2026) answers its measured figure from `result[0]` and the rest as Redis would
 * for a store with no other token out: its units added and counted, a give-back taken, the line joined.
 */
export async function redisPipeline(input: (string|number)[][]) {
  commands.push(input);
  if(fail)throw Error('unavailable');
  if(input.every((c)=>c[0]==='GET'))return result;
  // Rule 23 (9 November 2026, pre-review finding 2): a part grant's units are moved to the token's end with ZADD XX,
  // which Redis answers 0 (nothing added); before, every ZADD here but NX was the units' first add.
  const units=input.filter((c)=>c[0]==='ZADD'&&c[2]!=='NX'&&c[2]!=='XX').reduce((n,c)=>n+(c.length-2)/2,0);
  return input.map((c)=>c[0]==='GET'?result[0]:c[0]==='ZADD'?(c[2]==='NX'?1:c[2]==='XX'?0:(c.length-2)/2):c[0]==='ZCARD'?units:c[0]==='ZREM'?c.length-2:'OK');
}
export function set(value: unknown[], options: {configured?: boolean;fail?: boolean} = {}) {result=value;configured=options.configured??true;fail=options.fail??false;commands.length=0;}
