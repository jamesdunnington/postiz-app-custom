'use client';

import { useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { Button } from '@gitroom/react/form/button';
import { Select } from '@gitroom/react/form/select';
import { Input } from '@gitroom/react/form/input';
import { Textarea } from '@gitroom/react/form/textarea';

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

// Hard ceiling enforced by the backend too (see MAX_PINS_PER_BATCH in
// pinterest-delete.service.ts) — two rolling 24h windows' worth of pins.
const ABSOLUTE_MAX_PINS = 200;
const DEFAULT_MAX_PINS = 100;
// Actual per-account deletions allowed per rolling 24h window (DAILY_CAP in
// pinterest-delete.repository.ts). Not a calendar-day reset — deletions from
// any earlier batch (or MCP/API call) in the last 24h count against it too.
const DAILY_RATE_LIMIT = 100;

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
  const [maxPinsInput, setMaxPinsInput] = useState(String(DEFAULT_MAX_PINS));
  const [submitting, setSubmitting] = useState(false);

  const maxPins = useMemo(() => {
    const parsed = parseInt(maxPinsInput, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_MAX_PINS;
    return Math.min(ABSOLUTE_MAX_PINS, Math.max(1, parsed));
  }, [maxPinsInput]);

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

  const onMaxPinsBlur = useCallback(() => {
    setMaxPinsInput(String(maxPins));
  }, [maxPins]);

  const onSubmit = useCallback(async () => {
    const pins = pinsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (!selectedIntegrationId) {
      toaster.show('Select a Pinterest account first', 'warning');
      return;
    }

    if (pins.length === 0 || pins.length > maxPins) {
      toaster.show(`Paste between 1 and ${maxPins} pins`, 'warning');
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
  }, [pinsText, selectedIntegrationId, maxPins, fetch, toaster, mutateBatches]);

  const batches = batchesData || [];
  const nextQuotaResume = batches
    .flatMap((b) => b.items)
    .filter((i) => i.status === 'WAITING_FOR_QUOTA' && i.scheduledFor)
    .map((i) => i.scheduledFor as string)
    .sort()[0];

  return (
    <div className="flex flex-col gap-4 p-6 text-textColor">
      <div className="text-xl font-semibold">Pinterest Pin Cleanup</div>

      {pinterestIntegrations.length === 0 && (
        <div>Connect a Pinterest account first to use this tool.</div>
      )}

      {pinterestIntegrations.length > 0 && (
        <>
          <Select
            label="Pinterest account"
            name="integrationId"
            disableForm={true}
            value={selectedIntegrationId}
            onChange={(e) => setSelectedIntegrationId(e.target.value)}
          >
            <option value="">Select a Pinterest account</option>
            {pinterestIntegrations.map((integration) => (
              <option key={integration.id} value={integration.id}>
                {integration.name}
              </option>
            ))}
          </Select>

          <div className="max-w-[220px]">
            <Input
              label="Max pins per submission"
              name="maxPins"
              type="number"
              disableForm={true}
              removeError={true}
              min={1}
              max={ABSOLUTE_MAX_PINS}
              value={maxPinsInput}
              onChange={(e) => setMaxPinsInput(e.target.value)}
              onBlur={onMaxPinsBlur}
            />
          </div>

          <Textarea
            label="Pins to delete"
            name="pins"
            disableForm={true}
            className="min-h-[160px]"
            placeholder={`Paste one pin id or Pinterest pin URL per line (up to ${maxPins})`}
            value={pinsText}
            onChange={(e) => setPinsText(e.target.value)}
          />

          {maxPins > DAILY_RATE_LIMIT && (
            <div className="text-[12px] text-customColor18">
              Batches over {DAILY_RATE_LIMIT} pins will span more than one
              day: only {DAILY_RATE_LIMIT} deletions run per rolling 24-hour
              window per Pinterest account. The rest are queued automatically
              and processed once the window rolls forward — this keeps
              deletions from looking spammy to Pinterest.
            </div>
          )}

          <div className="flex items-center gap-3">
            <div>
              {pinCount}/{maxPins} pins
            </div>
            <Button
              disabled={
                submitting ||
                !selectedIntegrationId ||
                pinCount === 0 ||
                pinCount > maxPins
              }
              loading={submitting}
              onClick={onSubmit}
            >
              Submit for deletion
            </Button>
          </div>

          {nextQuotaResume && (
            <div className="bg-orange-950/40 border border-orange-800 text-orange-200 rounded p-3">
              Daily deletion limit reached for this account — resumes at{' '}
              {new Date(nextQuotaResume).toLocaleString()}.
              <div className="text-[12px] mt-1 opacity-80">
                This is a rolling 24-hour window, not a fixed daily reset —
                it counts every deletion for this account in the last 24
                hours, including from earlier batches.
              </div>
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
                  <div
                    key={batch.id}
                    className="border border-newTableBorder bg-newBgColorInner rounded p-3"
                  >
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
