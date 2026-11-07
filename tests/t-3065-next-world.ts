let token='';
export function setToken(value:string){token=value;}
export async function cookies(){return new Map([['nl_2fa',{value:token}]]);}
export class Redirected extends Error{constructor(readonly destination:string){super(destination);}}
export function redirect(destination:string):never{throw new Redirected(destination);}
