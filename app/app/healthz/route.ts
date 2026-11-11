// Batch 8 §3: keep-alive for the host. Answers 200 and never touches the database (spec §4 step 9).
export const dynamic = 'force-dynamic';

export function GET() {
  return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
