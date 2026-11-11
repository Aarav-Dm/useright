import { redirect } from 'next/navigation';
import { requireDevAccess } from '../../access';

// Batch 3's test screen became the deal room in batch 4.
export default async function DevBriefPage({ params }: { params: Promise<{ id: string }> }) {
  await requireDevAccess();
  const { id } = await params;
  redirect(`/deals/${encodeURIComponent(id)}`);
}
