/** Controlled hook lifecycle, not a browser or React scheduling implementation. */
const effects:(()=>void)[]=[];
export function resetEffects(){effects.length=0;}
export function flushEffects(){for(const effect of effects.splice(0))effect();}
export function useState<T>(initial:T|(()=>T)):[T,(next:T)=>void]{return[typeof initial==="function"?(initial as ()=>T)():initial,()=>{}];}
export function useEffect(effect:()=>void,deps:unknown[]){void deps;effects.push(effect);}
export function useSyncExternalStore(subscribe:unknown,read:()=>string|null,server:unknown){void subscribe;void server;return read();}
