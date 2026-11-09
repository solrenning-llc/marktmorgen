/** RED stub (758 [STN5] unit 3): the route is written in the next commit. */
export const maxDuration = 180;
export async function POST(): Promise<Response> {
  return Response.json({ ok: false, error: "off" }, { status: 501 });
}
