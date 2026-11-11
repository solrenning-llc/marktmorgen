export * from '../lib/stream';
export const PLAYER_SECONDS=14400;
export const isStreamConfigured=()=>true;
export const streamWatched=async()=>null;
/** Player tokens signed: a player is counted only when the time it may be good for was granted (lib/stream.ts, `life`). */
export let players=0;
export function reset(){players=0;}
export async function playerFor(_pathname?: string, _now?: number, life?: (record: {seconds: number}) => Promise<number | null>){
  const seconds=life?await life({seconds:600}):PLAYER_SECONDS;
  if(seconds===null)return null;
  players++;
  return{state:'ready',src:'https://example.invalid/player',width:1920,height:1080};
}
