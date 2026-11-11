import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { CREATOR_COOKIE, tokenMatches } from '@/lib/auth';

// Check before either development page can render or redirect.
export async function requireDevAccess() {
  if (process.env.NODE_ENV !== 'production') return;
  const token = (await cookies()).get(CREATOR_COOKIE)?.value;
  if (!tokenMatches(token)) notFound();
}
