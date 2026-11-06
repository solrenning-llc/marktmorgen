export * from '../lib/meta-ads';
import type { MetaConnectResult } from '../lib/meta-ads';
import { state } from './meta-return-counter-world';
export const isMetaConfigured=()=>state.configured;
export async function finishMeta():Promise<MetaConnectResult>{state.providerCalls++;return {ok:true,view:{} as MetaConnectResult extends {view:infer V}?V:never,account:null};}
