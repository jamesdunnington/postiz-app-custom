'use client';

import React, { useCallback, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { Button } from '@gitroom/react/form/button';

interface State {
  paused: boolean;
}

export const PublishingPauseControl: React.FC = () => {
  const fetch = useFetch();
  const toast = useToaster();
  const [busy, setBusy] = useState(false);

  const { data, mutate } = useSWR<State>(
    '/publishing/state',
    async (url: string) => (await fetch(url)).json(),
    { refreshInterval: 15000 }
  );

  const paused = !!data?.paused;

  const onPause = useCallback(async () => {
    if (!window.confirm('Pause all scheduled publishing? Posts will stop sending until you resume.')) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/publishing/pause', { method: 'POST' });
      if (!res.ok) throw new Error('pause_failed');
      toast.show('Publishing paused', 'success');
      mutate({ paused: true }, false);
    } catch {
      toast.show('Failed to pause publishing', 'warning');
    } finally {
      setBusy(false);
    }
  }, [fetch, mutate, toast]);

  const onResume = useCallback(async () => {
    if (
      !window.confirm(
        'Resume publishing? Missed posts will be moved to the back of each integration’s queue (the next available time slot per integration).'
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/publishing/resume', { method: 'POST' });
      if (!res.ok) throw new Error('resume_failed');
      const body = (await res.json()) as {
        postsRescheduled?: number;
        integrationsRescheduled?: number;
      };
      const n = body.postsRescheduled || 0;
      toast.show(
        n > 0
          ? `Publishing resumed — ${n} missed post${n === 1 ? '' : 's'} rescheduled across ${
              body.integrationsRescheduled
            } integration${body.integrationsRescheduled === 1 ? '' : 's'}`
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

  return (
    <div className="mt-[24px] border border-tableBorder p-[16px] flex flex-col gap-[8px]">
      <div className="text-[16px] font-semibold">Publishing control</div>
      <div className="text-[13px] opacity-80">
        {paused
          ? 'Publishing is PAUSED. Scheduled posts will not be sent until you resume.'
          : 'Publishing is running. Scheduled posts will be sent at their configured times.'}
      </div>
      <div className="mt-[8px]">
        {paused ? (
          <Button
            onClick={onResume}
            loading={busy}
            className="bg-green-600 hover:bg-green-700"
          >
            Resume publishing
          </Button>
        ) : (
          <Button
            onClick={onPause}
            loading={busy}
            className="bg-red-600 hover:bg-red-700"
          >
            Pause publishing
          </Button>
        )}
      </div>
    </div>
  );
};
