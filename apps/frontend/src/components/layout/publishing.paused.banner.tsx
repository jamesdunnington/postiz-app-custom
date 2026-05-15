'use client';

import React, { useCallback, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';

interface State {
  paused: boolean;
}

export const PublishingPausedBanner: React.FC<{ adminOnly?: boolean }> = ({
  adminOnly,
}) => {
  const fetch = useFetch();
  const toast = useToaster();
  const [busy, setBusy] = useState(false);

  const { data, mutate } = useSWR<State>(
    '/publishing/state',
    async (url: string) => (await fetch(url)).json(),
    { refreshInterval: 30000 }
  );

  const onResume = useCallback(async () => {
    if (
      !window.confirm(
        'Resume publishing? Missed posts will be moved to the back of each integration’s queue.'
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/publishing/resume', { method: 'POST' });
      if (!res.ok) throw new Error('resume_failed');
      const body = (await res.json()) as { postsRescheduled?: number };
      toast.show(
        body.postsRescheduled
          ? `Publishing resumed — ${body.postsRescheduled} missed post${
              body.postsRescheduled === 1 ? '' : 's'
            } rescheduled`
          : 'Publishing resumed',
        'success'
      );
      mutate({ paused: false }, false);
    } catch {
      toast.show('Failed to resume publishing', 'warning');
    } finally {
      setBusy(false);
    }
  }, [fetch, mutate, toast]);

  if (!data?.paused) return null;

  return (
    <div className="w-full bg-red-600 text-white text-center py-[6px] text-[13px] flex items-center justify-center gap-[12px]">
      <span>⏸ Publishing is PAUSED — scheduled posts are not being sent.</span>
      {adminOnly !== false && (
        <button
          onClick={onResume}
          disabled={busy}
          className="underline font-semibold disabled:opacity-50"
        >
          {busy ? 'Resuming…' : 'Resume now'}
        </button>
      )}
    </div>
  );
};
