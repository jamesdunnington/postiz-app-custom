'use client';

import React, { useCallback, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { Tooltip } from '@mantine/core';

interface State {
  paused: boolean;
}

export const PublishingToggle: React.FC = () => {
  const fetch = useFetch();
  const toast = useToaster();
  const [busy, setBusy] = useState(false);

  const { data, mutate } = useSWR<State>(
    '/publishing/state',
    async (url: string) => (await fetch(url)).json(),
    { refreshInterval: 15000 }
  );

  const paused = !!data?.paused;

  const onClick = useCallback(async () => {
    if (paused) {
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
            ? `Publishing resumed — ${n} missed post${n === 1 ? '' : 's'} rescheduled across ${body.integrationsRescheduled} integration${body.integrationsRescheduled === 1 ? '' : 's'}`
            : 'Publishing resumed',
          'success'
        );
        mutate({ paused: false }, false);
      } catch {
        toast.show('Failed to resume publishing', 'warning');
      } finally {
        setBusy(false);
      }
    } else {
      if (
        !window.confirm(
          'Pause all scheduled publishing? Posts will stop sending until you resume.'
        )
      ) {
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
    }
  }, [paused, fetch, mutate, toast]);

  if (data === undefined) return null;

  return (
    <Tooltip
      label={paused ? 'Publishing paused — click to resume' : 'Publishing running — click to pause'}
      withArrow
      position="bottom"
    >
      <div
        onClick={busy ? undefined : onClick}
        className={`select-none cursor-pointer transition-colors ${busy ? 'opacity-50 cursor-wait' : ''} ${paused ? 'text-red-500' : 'text-green-500'}`}
        aria-label={paused ? 'Resume publishing' : 'Pause publishing'}
      >
        {paused ? (
          // Play icon — click to resume
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
          >
            <path
              d="M6 4.75L17.25 12L6 19.25V4.75Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          // Pause icon — click to pause
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
          >
            <path
              d="M9 5V19M15 5V19"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
    </Tooltip>
  );
};
