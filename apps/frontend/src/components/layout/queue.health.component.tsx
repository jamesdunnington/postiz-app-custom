'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import clsx from 'clsx';

interface HealthData {
  healthy: boolean;
  issues: string[];
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  } | null;
}

const QueueHealthComponent = () => {
  const fetch = useFetch();
  const [health, setHealth] = useState<HealthData | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const response = await fetch('/monitor/queue/post', {
        method: 'GET',
      });

      const data = await response.json();

      if (response.ok) {
        setHealth({
          healthy: true,
          issues: [],
          counts: data.counts ?? null,
        });
      } else {
        setHealth({
          healthy: false,
          issues: data.issues ?? [data.message ?? 'Unknown issue'],
          counts: data.counts ?? null,
        });
      }
    } catch {
      setHealth({
        healthy: false,
        issues: ['Unable to reach health endpoint'],
        counts: null,
      });
    }
  }, [fetch]);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  const statusColor =
    health === null
      ? 'bg-gray-400'
      : health.healthy
      ? 'bg-green-500'
      : 'bg-red-500';

  const buildTooltip = () => {
    if (health === null) return 'Checking queue status...';
    if (health.healthy) {
      const parts = ['Queue is healthy — posts are being sent'];
      if (health.counts) {
        parts.push(
          `Active: ${health.counts.active}, Waiting: ${health.counts.waiting}, Failed: ${health.counts.failed}`
        );
      }
      return parts.join('\n');
    }
    const parts = ['Queue issue — posts may not be sending'];
    if (health.issues.length > 0) {
      parts.push(...health.issues);
    }
    if (health.counts) {
      parts.push(
        `Active: ${health.counts.active}, Waiting: ${health.counts.waiting}, Failed: ${health.counts.failed}`
      );
    }
    return parts.join('\n');
  };

  return (
    <div className="flex items-center gap-[6px] cursor-default" title={buildTooltip()}>
      <span
        className={clsx(
          'inline-block w-[10px] h-[10px] rounded-full',
          statusColor,
          health?.healthy && 'animate-pulse'
        )}
      />
      <span className="hidden md:inline text-[12px] text-textColor">
        {health === null ? 'Checking...' : health.healthy ? 'Healthy' : 'Unhealthy'}
      </span>
    </div>
  );
};

export default QueueHealthComponent;
