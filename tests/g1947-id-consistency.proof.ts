import { saveLanding, readLandings, dropLandings, finishLandingsDrop } from '@/lib/campaign-landing-store';
import { dropPage, PageDropIncomplete } from '@/lib/sales-page-store';
import { dataKey } from '@/lib/store-data';
import { ROOM } from './data-room';
import { store as redis } from './redis-stub';
import { done, is } from './check';

globalThis.fetch = async () => { throw Error('No external provider'); };
const stats = 'g'.repeat(16);
const value = { campaign: 'known', headline: 'Known headline', sub: 'Kept words', button: '' };
const caught = async (work: () => Promise<unknown>) => work().then(value => ({ok:true as const,value}), error => ({ok:false as const,error:String(error),incomplete:error instanceof PageDropIncomplete}));
async function main() {
  for (const id of ['normal-id', 'bad:child', 'x'.repeat(49)]) {
    redis.clear();
    const key = `nl:product:landing:${stats}:${id}`;
    const saved = await caught(() => saveLanding(stats,id,value,ROOM));
    const dropped = await caught(() => dropLandings(stats,id,ROOM));
    let held = (await redis.pipeline([['GET',key]]))[0];
    is(`${id}: accepted content is deleted or cleanup reports failure`, held === null || !dropped.ok, true);
    const page = await caught(() => dropPage(stats,id,ROOM));
    held = (await redis.pipeline([['GET',key]]))[0];
    is(`${id}: whole-page cleanup never claims complete while accepted content remains`, held === null || !page.ok, true);
    const finished = await caught(() => finishLandingsDrop(stats,id,ROOM));
    is(`${id}: a retained record never becomes confirmed none`, held === null || !finished.ok || finished.value !== 'none', true);
    const slot = (await redis.pipeline([['HGET',dataKey(ROOM)!,`al:${id}`]]))[0];
    is(`${id}: any retained content remains counted`, held === null || (typeof slot === 'string' && Number(slot) > 0), true);
    console.log('G_LANDING_ID_CONSISTENCY',JSON.stringify({id,saved,dropped,page,finished,held,slot,read:await readLandings(stats,id)}));
  }
  done();
}
void main();
