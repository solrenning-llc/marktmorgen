/** Independent conditional concurrency proof: a late HSET can overwrite a newer budget even when rejected. */
import { startCallBudget, takeCalls, workKey } from '@/lib/closing-holds';
import { store as redis } from '../../../tests/redis-stub';
import { done, is, part } from '../../../tests/check';

const raw = redis.pipeline.bind(redis);
const folder = 's3309-interleave';
let hooked = false;
let innerAccepted = false;
let took = false;
let outerReply: unknown;
let modelHsetReply: unknown;

async function main(): Promise<void> {
  redis.clear();
  part('Two budget starts interleave after the first DEL; the newer worker spends one call');
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!hooked && commands.length === 2 && commands[0]?.[0] === 'DEL' && commands[1]?.[0] === 'HSET' && commands[1]?.[2] === 'calls') {
      hooked = true;
      const cleared = await raw([commands[0]]);
      await startCallBudget(folder, 5);
      innerAccepted = true;
      took = await takeCalls(folder, 1);
      // MemoryRedis's basic HSET always returns 1. Keep the actual write, but
      // derive this single-field reply from pre-write existence, as Redis does.
      const existed = await raw([['HEXISTS', workKey(folder), 'calls']]);
      const written = await raw([commands[1]]);
      modelHsetReply = written[0];
      outerReply = [cleared[0], existed[0] === 1 ? 0 : 1];
      return outerReply;
    }
    return raw(commands);
  }) as typeof redis.pipeline;
  let rejected = false;
  try { await startCallBudget(folder, 5); } catch { rejected = true; }
  finally { redis.pipeline = raw; }
  is('the controlled interleaving actually ran', hooked, true);
  is('the newer budget was accepted and one call taken', [innerAccepted, took], [true, true]);
  is('the late HSET is exactly a replacement, not a fresh field', outerReply, [0, 0]);
  console.log('S_INTERLEAVING', JSON.stringify({ rejected, modelHsetReply, remaining: (await raw([['HGET', workKey(folder), 'calls']]))[0] }));
  is('one already consumed call remains debited after the late write', (await raw([['HGET', workKey(folder), 'calls']]))[0], '4');
  is('only the four unspent calls can still be taken', [await takeCalls(folder, 4), await takeCalls(folder, 1)], [true, false]);
  done();
}
void main();
