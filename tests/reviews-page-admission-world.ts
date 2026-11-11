/** next/headers and next/navigation for the public pages' admission tests: no domain header, and a refusal throws. */
export async function headers() { return new Headers(); }
export async function cookies() { return { get: () => undefined }; }
export function notFound(): never { throw new Error("SYNTHETIC_NOT_FOUND"); }
export function redirect(to: string): never { throw new Error(`SYNTHETIC_REDIRECT ${to}`); }
export function permanentRedirect(to: string): never { throw new Error(`SYNTHETIC_REDIRECT ${to}`); }
