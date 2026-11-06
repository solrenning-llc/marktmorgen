export * from '../../tests/storage-provider-stub';
export const observed={list:[] as {prefix:string;limit:number;cursor?:string}[],vault:0,stream:0};
let pages:unknown[]=[],vault:number|null=0,video:number|null=0;
export function reset(input:unknown[],v:number|null=0,s:number|null=0){pages=[...input];vault=v;video=s;observed.list=[];observed.vault=0;observed.stream=0;}
export async function list(options:{prefix:string;limit:number;cursor?:string}):Promise<unknown>{observed.list.push({...options});const next=pages.shift();if(next instanceof Error)throw next;return next??{blobs:[],hasMore:false};}
export async function vaultHeld(){observed.vault++;return vault;}
export async function streamHeld(){observed.stream++;return video;}
