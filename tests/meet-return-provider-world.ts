export * from '../lib/meet-connect';
import type { ConnectResult } from '../lib/meet-connect';
import { state } from './meet-return-counter-world';
export async function finishConsent():Promise<ConnectResult>{state.providerCalls++;return {ok:true,view:{account:'synthetic-account'} as Extract<ConnectResult,{ok:true}>['view'],replaced:false};}
