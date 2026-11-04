/** This stable public door is reserved but unavailable. There is no reviewed
 * original-payment/refund access contract or funded identity lookup yet.
 * In particular no URL, cookie, query or header can activate a course source.
 * Keep the refusal before ANY store/catalog/provider IO or authentication.
 */
export async function GET() {
  return new Response("This course link is not available yet. Please contact the store.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
