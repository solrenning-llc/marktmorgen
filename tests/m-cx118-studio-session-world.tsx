/** Next request/runtime adapters only; no business decisions are replaced. */
export * from '../node_modules/next/server.js';
export {answering,headers,cookies} from '@/tests/security/next-headers';
export function after(task: unknown): void { void task; }
export function redirect(to:string):never{throw Error('REDIRECT '+to);}
export function permanentRedirect(to:string):never{throw Error('REDIRECT '+to);}
export function notFound():never{throw Error('NOT_FOUND');}
export function useRouter(){return {};}
export function usePathname(){return '/';}
export function useSearchParams(){return new URLSearchParams();}
