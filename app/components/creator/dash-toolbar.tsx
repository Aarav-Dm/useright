'use client';
// Batch 7C: the dashboard header actions on every creator page: share the public request page, add a client request.
// Phase 3 adds the quick-action box and the activity bell in front of them (the existing two keep their place).
import { ActivityBell } from '@/components/creator/activity-bell';
import { QuickActions } from '@/components/creator/quick-actions';
import { RequestSheet } from '@/components/creator/request-sheet';
import { SharePage } from '@/components/creator/share-page';

export function DashToolbar({ slug }: { slug: string }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-end gap-2">
      {/* review B7C-3 finding 8: on a phone the two icon buttons take their own row, so Share and Add stay together. */}
      <div className="flex items-center gap-2 max-sm:basis-full max-sm:justify-end">
        <QuickActions />
        <ActivityBell />
      </div>
      <SharePage slug={slug} />
      <RequestSheet />
    </div>
  );
}
