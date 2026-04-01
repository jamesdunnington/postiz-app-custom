'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import clsx from 'clsx';

const QueueHealthComponent = () => {
  const fetch = useFetch();
  const [healthy, setHealthy] = useState<boolean | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const response = await fetch('/monitor/queue/post', {
        method: 'GET',
      });

      setHealthy(response.ok);
    } catch {
      setHealthy(false);
    }
  }, [fetch]);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  const statusColor =
    healthy === null
      ? 'bg-gray-400'
      : healthy
      ? 'bg-green-500'
      : 'bg-red-500';

  const statusLabel =
    healthy === null
      ? 'Checking queue status...'
      : healthy
      ? 'Queue is healthy — posts are being sent'
      : 'Queue issue — posts may not be sending';

  return (
    <div className="flex items-center gap-[6px] cursor-default" title={statusLabel}>
      <span
        className={clsx(
          'inline-block w-[10px] h-[10px] rounded-full',
          statusColor,
          healthy && 'animate-pulse'
        )}
      />
      <span className="hidden md:inline text-[12px] text-textColor">
        {healthy === null ? 'Checking...' : healthy ? 'Healthy' : 'Unhealthy'}
      </span>
    </div>
  );
};

export default QueueHealthComponent;
