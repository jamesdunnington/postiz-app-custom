'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { orderBy } from 'lodash';
import clsx from 'clsx';
import Image from 'next/image';
import useCookie from 'react-use-cookie';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { Textarea } from '@gitroom/react/form/textarea';
import ImageWithFallback from '@gitroom/react/helpers/image.with.fallback';
import { SVGLine } from '@gitroom/frontend/components/launches/launches.component';

interface IntegrationListItem {
  id: string;
  name: string;
  identifier: string;
  picture: string;
  disabled?: boolean;
  refreshNeeded?: boolean;
  inBetweenSteps?: boolean;
}

interface PinterestDeleteFailedItem {
  id: string;
  pinId: string;
  rawInput: string;
  errorMessage: string | null;
  processedAt: string | null;
}

interface PinterestDeleteQueuedItem {
  id: string;
  pinId: string;
  rawInput: string;
  scheduledFor: string | null;
}

interface PinterestDeleteQueueSummary {
  queued: number;
  queuedItems: PinterestDeleteQueuedItem[];
  done: number;
  failed: PinterestDeleteFailedItem[];
  totalEverSubmitted: number;
  nextRunAt: string | null;
  lastCompletionAt: string | null;
}

interface PinterestDeletePace {
  pinDeletePaceMinMinutes: number;
  pinDeletePaceMaxMinutes: number;
  pinDeletePaceBatchSize: number;
}

// Hard ceiling enforced by the backend too (see MAX_PINS_PER_BATCH in
// pinterest-delete.service.ts) — a sane cap on one form submission. Multiple
// submissions append to the same ongoing per-account queue.
const ABSOLUTE_MAX_PINS = 200;
const DEFAULT_MAX_PINS = 100;

export const PinterestCleanupComponent = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [collapseMenu, setCollapseMenu] = useCookie('collapseMenu', '0');
  const [selectedIntegrationId, setSelectedIntegrationId] = useState('');
  const [pinsText, setPinsText] = useState('');
  const [maxPinsInput, setMaxPinsInput] = useState(String(DEFAULT_MAX_PINS));
  const [submitting, setSubmitting] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(
    new Set()
  );
  const [cancelling, setCancelling] = useState(false);
  const [minMinutesInput, setMinMinutesInput] = useState('');
  const [maxMinutesInput, setMaxMinutesInput] = useState('');
  const [batchSizeInput, setBatchSizeInput] = useState('');
  const [savingPace, setSavingPace] = useState(false);

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
      orderBy(
        (integrationsData?.integrations || []).filter(
          (i: IntegrationListItem) => i.identifier === 'pinterest'
        ),
        ['name'],
        ['asc']
      ),
    [integrationsData]
  );

  // Keep a channel selected by default (matches the Calendar/Analytics
  // sidebars), and drop the selection if that channel disappears.
  useEffect(() => {
    if (pinterestIntegrations.length === 0) {
      if (selectedIntegrationId) setSelectedIntegrationId('');
      return;
    }
    if (!pinterestIntegrations.some((i) => i.id === selectedIntegrationId)) {
      setSelectedIntegrationId(pinterestIntegrations[0].id);
    }
  }, [pinterestIntegrations, selectedIntegrationId]);

  const { data: queueData, mutate: mutateQueue } = useSWR<
    PinterestDeleteQueueSummary
  >(
    selectedIntegrationId
      ? `pinterest-delete-queue-${selectedIntegrationId}`
      : null,
    async () =>
      (
        await fetch(`/pinterest-delete/queue?integrationId=${selectedIntegrationId}`)
      ).json(),
    { refreshInterval: 7000 }
  );

  const { data: paceData, mutate: mutatePace } = useSWR<PinterestDeletePace>(
    selectedIntegrationId
      ? `pinterest-delete-pace-${selectedIntegrationId}`
      : null,
    async () =>
      (
        await fetch(`/pinterest-delete/pace?integrationId=${selectedIntegrationId}`)
      ).json()
  );

  // Reset the editable fields to whatever's saved whenever the account
  // changes or a fresh save comes back — never while the user is mid-edit.
  useEffect(() => {
    if (!paceData) return;
    setMinMinutesInput(String(paceData.pinDeletePaceMinMinutes));
    setMaxMinutesInput(String(paceData.pinDeletePaceMaxMinutes));
    setBatchSizeInput(String(paceData.pinDeletePaceBatchSize));
  }, [paceData]);

  const onSavePace = useCallback(async () => {
    const minMinutes = parseInt(minMinutesInput, 10);
    const maxMinutes = parseInt(maxMinutesInput, 10);
    const batchSize = parseInt(batchSizeInput, 10);

    if (!Number.isFinite(minMinutes) || !Number.isFinite(maxMinutes) || !Number.isFinite(batchSize)) {
      toaster.show('Enter valid numbers', 'warning');
      return;
    }
    if (minMinutes > maxMinutes) {
      toaster.show('Min minutes must not be greater than max minutes', 'warning');
      return;
    }

    setSavingPace(true);
    try {
      const response = await fetch('/pinterest-delete/pace', {
        method: 'POST',
        body: JSON.stringify({
          integrationId: selectedIntegrationId,
          minMinutes,
          maxMinutes,
          batchSize,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}) as any);
        toaster.show(body.message || 'Failed to save', 'warning');
        return;
      }

      toaster.show(
        'Pacing saved — applies to pins submitted from now on, already-queued pins are unaffected',
        'success'
      );
      mutatePace();
    } finally {
      setSavingPace(false);
    }
  }, [minMinutesInput, maxMinutesInput, batchSizeInput, selectedIntegrationId, fetch, toaster, mutatePace]);

  // Drop any selected id that no longer exists in the queue (cancelled
  // elsewhere, or already drained) so "Cancel selected" never resubmits a
  // stale id, and clear the selection entirely when switching accounts.
  useEffect(() => {
    setSelectedItemIds(new Set());
  }, [selectedIntegrationId]);

  useEffect(() => {
    if (!queueData) return;
    const stillQueued = new Set(queueData.queuedItems.map((i) => i.id));
    setSelectedItemIds((prev) => {
      const next = new Set([...prev].filter((id) => stillQueued.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [queueData]);

  const toggleItemSelected = useCallback((itemId: string) => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedItemIds((prev) => {
      const allIds = (queueData?.queuedItems || []).map((i) => i.id);
      return prev.size === allIds.length ? new Set() : new Set(allIds);
    });
  }, [queueData]);

  const onCancelSelected = useCallback(
    async (itemIds: string[]) => {
      if (!selectedIntegrationId || itemIds.length === 0) return;

      setCancelling(true);
      try {
        const response = await fetch('/pinterest-delete/cancel', {
          method: 'POST',
          body: JSON.stringify({
            integrationId: selectedIntegrationId,
            itemIds,
          }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({}) as any);
          toaster.show(body.message || 'Failed to cancel', 'warning');
          return;
        }

        const result = await response.json();
        toaster.show(
          `Cancelled ${result.cancelledIds?.length ?? 0} pin(s)`,
          'success'
        );
        setSelectedItemIds(new Set());
        mutateQueue();
      } finally {
        setCancelling(false);
      }
    },
    [selectedIntegrationId, fetch, toaster, mutateQueue]
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
      mutateQueue();
    } finally {
      setSubmitting(false);
    }
  }, [pinsText, selectedIntegrationId, maxPins, fetch, toaster, mutateQueue]);

  return (
    <>
      <div
        className={clsx(
          'bg-newBgColorInner p-[20px] flex flex-col gap-[15px] transition-all',
          collapseMenu === '1' ? 'group sidebar w-[100px]' : 'w-[260px]'
        )}
      >
        <div className="flex gap-[12px] flex-col">
          <div className="flex items-center">
            <h2 className="group-[.sidebar]:hidden flex-1 text-[20px] font-[500]">
              Channels
            </h2>
            <div
              onClick={() => setCollapseMenu(collapseMenu === '1' ? '0' : '1')}
              className="group-[.sidebar]:rotate-[180deg] group-[.sidebar]:mx-auto text-btnText bg-btnSimple rounded-[6px] w-[24px] h-[24px] flex items-center justify-center cursor-pointer select-none"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="7"
                height="13"
                viewBox="0 0 7 13"
                fill="none"
              >
                <path
                  d="M6 11.5L1 6.5L6 1.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          </div>

          {pinterestIntegrations.length === 0 && (
            <div className="group-[.sidebar]:hidden text-[12px] text-customColor18">
              No Pinterest accounts connected yet.
            </div>
          )}

          {pinterestIntegrations.map((integration) => (
            <div
              key={integration.id}
              onClick={() => {
                if (integration.refreshNeeded) {
                  toaster.show(
                    'Please refresh the integration from the calendar',
                    'warning'
                  );
                  return;
                }
                setSelectedIntegrationId(integration.id);
              }}
              className={clsx(
                'flex gap-[12px] items-center group/profile justify-center hover:bg-boxHover rounded-e-[8px]',
                selectedIntegrationId !== integration.id &&
                  'opacity-20 hover:opacity-100 cursor-pointer'
              )}
            >
              <div
                className={clsx(
                  'relative rounded-full flex justify-center items-center gap-[6px]',
                  integration.disabled && 'opacity-50'
                )}
              >
                {(integration.inBetweenSteps || integration.refreshNeeded) && (
                  <div className="absolute start-0 top-0 w-[39px] h-[46px] cursor-pointer">
                    <div className="bg-red-500 w-[15px] h-[15px] rounded-full start-0 -top-[5px] absolute z-[200] text-[10px] flex justify-center items-center">
                      !
                    </div>
                    <div className="bg-primary/60 w-[39px] h-[46px] start-0 top-0 absolute rounded-full z-[199]" />
                  </div>
                )}
                <div className="h-full w-[4px] -ms-[12px] rounded-s-[3px] opacity-0 group-hover/profile:opacity-100 transition-opacity">
                  <SVGLine />
                </div>
                <ImageWithFallback
                  fallbackSrc={`/icons/platforms/${integration.identifier}.png`}
                  src={integration.picture}
                  className="rounded-[8px]"
                  alt={integration.identifier}
                  width={36}
                  height={36}
                />
                <Image
                  src={`/icons/platforms/${integration.identifier}.png`}
                  className="rounded-[8px] absolute z-10 bottom-[5px] -end-[5px] border border-fifth"
                  alt={integration.identifier}
                  width={18.41}
                  height={18.41}
                />
              </div>
              <div
                className={clsx(
                  'flex-1 whitespace-nowrap text-ellipsis overflow-hidden group-[.sidebar]:hidden',
                  integration.disabled && 'opacity-50'
                )}
              >
                {integration.name}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-newBgColorInner flex-1 flex flex-col gap-4 p-6 text-textColor">
        <div className="text-xl font-semibold">Pinterest Pin Cleanup</div>

        {pinterestIntegrations.length === 0 && (
          <div>Connect a Pinterest account first to use this tool.</div>
        )}

        {pinterestIntegrations.length > 0 && !selectedIntegrationId && (
          <div>Select a Pinterest account from the channels on the left.</div>
        )}

        {selectedIntegrationId && (
          <>
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

            <div className="flex flex-col gap-2">
              <div className="text-lg font-semibold">Deletion pacing</div>
              <div className="border border-newTableBorder bg-sixth rounded p-3 flex flex-col gap-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="max-w-[140px]">
                    <Input
                      label="Min minutes"
                      name="minMinutes"
                      type="number"
                      disableForm={true}
                      removeError={true}
                      min={1}
                      max={1440}
                      value={minMinutesInput}
                      onChange={(e) => setMinMinutesInput(e.target.value)}
                    />
                  </div>
                  <div className="max-w-[140px]">
                    <Input
                      label="Max minutes"
                      name="maxMinutes"
                      type="number"
                      disableForm={true}
                      removeError={true}
                      min={1}
                      max={1440}
                      value={maxMinutesInput}
                      onChange={(e) => setMaxMinutesInput(e.target.value)}
                    />
                  </div>
                  <div className="max-w-[140px]">
                    <Input
                      label="Pins per interval"
                      name="batchSize"
                      type="number"
                      disableForm={true}
                      removeError={true}
                      min={1}
                      max={10}
                      value={batchSizeInput}
                      onChange={(e) => setBatchSizeInput(e.target.value)}
                    />
                  </div>
                  <Button loading={savingPace} onClick={onSavePace}>
                    Save pacing
                  </Button>
                </div>
                <div className="text-[12px] text-customColor18">
                  {batchSizeInput && batchSizeInput !== '1'
                    ? `Pinterest deletes ${batchSizeInput} pin(s) together every ${minMinutesInput}-${maxMinutesInput} minutes (randomized)`
                    : `Pins are deleted one at a time, every ${minMinutesInput || '50'}-${maxMinutesInput || '60'} minutes (randomized)`}
                  {' '}— this keeps deletions from looking spammy to Pinterest.
                  Only applies to pins submitted after you save; anything
                  already queued keeps its current schedule. Older, more
                  established accounts can usually tolerate a faster pace
                  than newer ones.
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="text-lg font-semibold">Queue status</div>
              <div className="border border-newTableBorder bg-sixth rounded p-3 flex flex-col gap-1">
                <div>
                  Queued: {queueData?.queued ?? 0} · Done: {queueData?.done ?? 0} ·
                  Failed: {queueData?.failed.length ?? 0} · Total submitted:{' '}
                  {queueData?.totalEverSubmitted ?? 0}
                </div>
                <div className="text-[12px] text-customColor18">
                  Next deletion at:{' '}
                  {queueData?.nextRunAt
                    ? new Date(queueData.nextRunAt).toLocaleString()
                    : '—'}{' '}
                  · Last one completes:{' '}
                  {queueData?.lastCompletionAt
                    ? new Date(queueData.lastCompletionAt).toLocaleString()
                    : '—'}
                </div>
              </div>

              {queueData && queueData.queuedItems.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-3">
                    <div className="text-lg font-semibold flex-1">
                      Queued pins ({queueData.queuedItems.length})
                    </div>
                    <label className="flex items-center gap-2 text-[12px] cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={
                          selectedItemIds.size ===
                            queueData.queuedItems.length &&
                          queueData.queuedItems.length > 0
                        }
                        onChange={toggleSelectAll}
                      />
                      Select all
                    </label>
                    <Button
                      disabled={cancelling || selectedItemIds.size === 0}
                      loading={cancelling}
                      onClick={() =>
                        onCancelSelected(Array.from(selectedItemIds))
                      }
                    >
                      Cancel selected ({selectedItemIds.size})
                    </Button>
                  </div>
                  <div className="flex flex-col gap-1 max-h-[320px] overflow-y-auto">
                    {queueData.queuedItems.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center gap-3 border border-newTableBorder bg-sixth rounded p-3"
                      >
                        <input
                          type="checkbox"
                          className="cursor-pointer"
                          checked={selectedItemIds.has(item.id)}
                          onChange={() => toggleItemSelected(item.id)}
                        />
                        <div className="flex-1 truncate" title={item.rawInput}>
                          {item.rawInput}
                        </div>
                        <div className="text-[12px] text-customColor18 whitespace-nowrap">
                          {item.scheduledFor
                            ? new Date(item.scheduledFor).toLocaleString()
                            : '—'}
                        </div>
                        <Button
                          disabled={cancelling}
                          onClick={() => onCancelSelected([item.id])}
                        >
                          Cancel
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {queueData && queueData.failed.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="text-lg font-semibold">Failed pins</div>
                  {queueData.failed.map((item) => (
                    <div
                      key={item.id}
                      className="border border-newTableBorder bg-sixth rounded p-3"
                    >
                      <div className="truncate" title={item.rawInput}>
                        {item.rawInput}
                      </div>
                      <div className="text-red-400 text-[12px]">
                        {item.errorMessage}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
};
