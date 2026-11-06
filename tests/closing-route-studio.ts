// The studio's own sign-in, stood in for: the store is the one the test names, read as the route would.
export * from '../lib/studio-route';
import { storeForEmail, storeRef } from '../lib/store';
export const signedIn = { email: '' };
export const creatorFrom = async () => {
  const store = (await storeForEmail(signedIn.email))!;
  return { ref: storeRef(store), store, origin: 'https://marktmorgen.test', studio: (query: string) => '/studio?' + query };
};
export const away = (origin: string, path: string) => new Response(null, { status: 303, headers: { Location: new URL(path, origin).href } });
