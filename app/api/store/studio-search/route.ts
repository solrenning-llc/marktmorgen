// RED stub: 766 [STN13] unit 1; the route comes in the next commit.
export async function POST(): Promise<Response> {
  return Response.json({ ok: false, error: "not_built" }, { status: 501 });
}
