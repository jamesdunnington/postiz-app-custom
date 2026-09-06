'use client';

import { useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';

interface IntegrationListItem {
  id: string;
  name: string;
  identifier: string;
}

interface PinterestDeleteItemSummary {
  id: string;
  status: 'PENDING' | 'QUEUED' | 'REMOVED' | 'FAILED' | 'WAITING_FOR_QUOTA';
  scheduledFor: string | null;
}

interface PinterestDeleteBatchSummary {
  id: string;
  createdAt: string;
  submittedCount: number;
  source: string;
  items: PinterestDeleteItemSummary[];
}

const MAX_PINS = 100;

function summarize(items: PinterestDeleteItemSummary[]) {
  return {
    removed: items.filter((i) => i.status === 'REMOVED').length,
    failed: items.filter((i) => i.status === 'FAILED').length,
    waiting: items.filter((i) => i.status === 'WAITING_FOR_QUOTA').length,
    pending: items.filter((i) => i.status === 'PENDING' || i.status === 'QUEUED')
      .length,
  };
}

export const PinterestCleanupComponent = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [selectedIntegrationId, setSelectedIntegrationId] = useState('');
  const [pinsText, setPinsText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { data: integrationsData } = useSWR('integrations', async () =>
    (await fetch('/integrations/list')).json()
  );

  const pinterestIntegrations: IntegrationListItem[] = useMemo(
    () =>
      (integrationsData?.integrations || []).filter(
        (i: IntegrationListItem) => i.identifier === 'pinterest'
      ),
    [integrationsData]
  );

  const { data: batchesData, mutate: mutateBatches } = useSWR<
    PinterestDeleteBatchSummary[]
  >(
    selectedIntegrationId
      ? `pinterest-delete-batches-${selectedIntegrationId}`
      : null,
    async () =>
      (
        await fetch(
          `/pinterest-delete/batches?integrationId=${selectedIntegrationId}`
        )
      ).json(),
    { refreshInterval: 7000 }
  );

  const pinCount = useMemo(
    () =>
      pinsText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean).length,
    [pinsText]
  );

  const onSubmit = useCallback(async () => {
    const pins = pinsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (!selectedIntegrationId) {
      toaster.show('Select a Pinterest account first', 'warning');
      return;
    }

    if (pins.length === 0 || pins.length > MAX_PINS) {
      toaster.show(`Paste between 1 and ${MAX_PINS} pins`, 'warning');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/pinterest-delete/batches', {
        method: 'POST',
        body: JSON.stringify({ integrationId: selectedIntegrationId, pins }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}) as any);
        toaster.show(body.message || 'Failed to submit batch', 'warning');
        return;
      }

      setPinsText('');
      toaster.show('Batch submitted', 'success');
      mutateBatches();
    } finally {
      setSubmitting(false);
    }
  }, [pinsText, selectedIntegrationId, fetch, toaster, mutateBatches]);

  const batches = batchesData || [];
  const nextQuotaResume = batches
    .flatMap((b) => b.items)
    .filter((i) => i.status === 'WAITING_FOR_QUOTA' && i.scheduledFor)
    .map((i) => i.scheduledFor as string)
    .sort()[0];

  return (
    <div className="flex flex-col gap-4 p-6 text-white">
      <div className="text-xl font-semibold">Pinterest Pin Cleanup</div>

      {pinterestIntegrations.length === 0 && (
        <div>Connect a Pinterest account first to use this tool.</div>
      )}

      {pinterestIntegrations.length > 0 && (
        <>
          <select
            className="bg-black border border-white/20 rounded p-2"
            value={selectedIntegrationId}
            onChange={(e) => setSelectedIntegrationId(e.target.value)}
          >
            <option value="">Select a Pinterest account</option>
            {pinterestIntegrations.map((integration) => (
              <option key={integration.id} value={integration.id}>
                {integration.name}
              </option>
            ))}
          </select>

          <textarea
            className="bg-black border border-white/20 rounded p-2 min-h-[160px]"
            placeholder="Paste one pin id or Pinterest pin URL per line (up to 100)"
            value={pinsText}
            onChange={(e) => setPinsText(e.target.value)}
          />

          <div className="flex items-center gap-3">
            <div>
              {pinCount}/{MAX_PINS} pins
            </div>
            <button
              className="bg-blue-600 text-white rounded px-4 py-2 disabled:opacity-50"
              disabled={
                submitting ||
                !selectedIntegrationId ||
                pinCount === 0 ||
                pinCount > MAX_PINS
              }
              onClick={onSubmit}
            >
              Submit for deletion
            </button>
          </div>

          {nextQuotaResume && (
            <div className="bg-yellow-900 text-yellow-200 rounded p-3">
              Daily deletion limit reached for this account — resumes at{' '}
              {new Date(nextQuotaResume).toLocaleString()}.
            </div>
          )}

          {selectedIntegrationId && (
            <div className="flex flex-col gap-2">
              <div className="text-lg font-semibold">History</div>
              {batches.length === 0 && (
                <div>No batches submitted yet for this account.</div>
              )}
              {batches.map((batch) => {
                const counts = summarize(batch.items);
                return (
                  <div key={batch.id} className="border border-white/20 rounded p-3">
                    <div>
                      {new Date(batch.createdAt).toLocaleString()} —{' '}
                      {batch.submittedCount} submitted ({batch.source})
                    </div>
                    <div>
                      Removed: {counts.removed} · Failed: {counts.failed} ·
                      Waiting on daily limit: {counts.waiting} · Pending:{' '}
                      {counts.pending}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};
