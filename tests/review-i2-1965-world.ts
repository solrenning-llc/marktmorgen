import type { Store } from '@/lib/store';
export { studioPath } from '../lib/studio-route';
export const cookies = async () => ({});
export const headers = async () => new Headers();
export let current: Store;
export function useStore(store: Store) { current = store; }
export async function studioView() {
  return {ok:true,view:{store:current,role:'owner',stores:[{store:current,role:'owner'}],owned:1}};
}
