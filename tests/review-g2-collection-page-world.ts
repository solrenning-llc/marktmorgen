/** Only Next request context is synthetic; all product readers and admission functions stay real. */
export async function headers(){return new Headers();}
export async function cookies(){return{get:()=>undefined,getAll:()=>[]};}
