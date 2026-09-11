'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import Papa from 'papaparse';
import { orderBy } from 'lodash';
import clsx from 'clsx';
import Image from 'next/image';
import useCookie from 'react-use-cookie';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { Button } from '@gitroom/react/form/button';
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

interface CsvRow {
  content: string;
  title: string;
  image_url: string;
  scheduled_date: string;
  board: string;
  alt_text: string;
  link: string;
}

interface ParsedRow {
  content: string;
  title?: string;
  imageUrl: string;
  boardId: string;
  altText?: string;
  link?: string;
  scheduledDate?: string;
  validationError?: string;
}

interface BatchScheduleQueueItem {
  id: string;
  content: string;
  boardId: string;
  status: 'PENDING' | 'SCHEDULED' | 'FAILED';
  assignedPublishDate: string;
  postizPostId: string | null;
  errorMessage: string | null;
}

interface BatchScheduleQueueSummary {
  queued: number;
  done: number;
  failed: { id: string; content: string; boardId: string; errorMessage: string | null }[];
  totalEverSubmitted: number;
  items: BatchScheduleQueueItem[];
}

const MAX_ROWS_PER_SUBMISSION = 500;

function parseRow(row: CsvRow): ParsedRow {
  const content = (row.content || '').trim();
  const imageUrl = (row.image_url || '').trim();
  const boardId = (row.board || '').trim();

  let validationError: string | undefined;
  if (!content) validationError = 'Missing content';
  else if (!imageUrl) validationError = 'Missing image_url';
  else if (!boardId) validationError = 'Missing board';

  return {
    content,
    title: (row.title || '').trim() || undefined,
    imageUrl,
    boardId,
    altText: (row.alt_text || '').trim() || undefined,
    link: (row.link || '').trim() || undefined,
    scheduledDate: (row.scheduled_date || '').trim() || undefined,
    validationError,
  };
}

export const BatchScheduleComponent = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [collapseMenu, setCollapseMenu] = useCookie('collapseMenu', '0');
  const [selectedIntegrationId, setSelectedIntegrationId] = useState('');
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [submitting, setSubmitting] = useState(false);

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

  useEffect(() => {
    if (pinterestIntegrations.length === 0) {
      if (selectedIntegrationId) setSelectedIntegrationId('');
      return;
    }
    if (!pinterestIntegrations.some((i) => i.id === selectedIntegrationId)) {
      setSelectedIntegrationId(pinterestIntegrations[0].id);
    }
  }, [pinterestIntegrations, selectedIntegrationId]);

  useEffect(() => {
    setParsedRows([]);
  }, [selectedIntegrationId]);

  const { data: queueData, mutate: mutateQueue } = useSWR<BatchScheduleQueueSummary>(
    selectedIntegrationId ? `batch-schedule-queue-${selectedIntegrationId}` : null,
    async () =>
      (
        await fetch(`/batch-schedule/queue?integrationId=${selectedIntegrationId}`)
      ).json(),
    { refreshInterval: 7000 }
  );

  const onFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      Papa.parse<CsvRow>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const rows = results.data.map(parseRow).slice(0, MAX_ROWS_PER_SUBMISSION);
          setParsedRows(rows);
        },
      });

      e.target.value = '';
    },
    []
  );

  const validRows = useMemo(
    () => parsedRows.filter((r) => !r.validationError),
    [parsedRows]
  );

  const onSubmit = useCallback(async () => {
    if (!selectedIntegrationId || validRows.length === 0) {
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/batch-schedule/batches', {
        method: 'POST',
        body: JSON.stringify({
          integrationId: selectedIntegrationId,
          rows: validRows.map((r) => ({
            content: r.content,
            title: r.title,
            imageUrl: r.imageUrl,
            boardId: r.boardId,
            altText: r.altText,
            link: r.link,
            scheduledDate: r.scheduledDate,
          })),
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}) as any);
        toaster.show(body.message || 'Failed to submit batch', 'warning');
        return;
      }

      setParsedRows([]);
      toaster.show('Batch submitted', 'success');
      mutateQueue();
    } finally {
      setSubmitting(false);
    }
  }, [selectedIntegrationId, validRows, fetch, toaster, mutateQueue]);

  const onRetry = useCallback(
    async (itemId: string) => {
      const response = await fetch(`/batch-schedule/items/${itemId}/retry`, {
        method: 'POST',
      });
      if (!response.ok) {
        toaster.show('Failed to retry item', 'warning');
        return;
      }
      toaster.show('Item queued for retry', 'success');
      mutateQueue();
    },
    [fetch, toaster, mutateQueue]
  );

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

      <div className="bg-newBgColorInner flex-1 flex flex-col gap-4 p-6 text-textColor overflow-y-auto">
        <div className="text-xl font-semibold">Pinterest Batch Scheduling</div>

        {pinterestIntegrations.length === 0 && (
          <div>Connect a Pinterest account first to use this tool.</div>
        )}

        {pinterestIntegrations.length > 0 && !selectedIntegrationId && (
          <div>Select a Pinterest account from the channels on the left.</div>
        )}

        {selectedIntegrationId && (
          <>
            <div className="text-[12px] text-customColor18">
              Upload a CSV with columns: content, title, image_url,
              scheduled_date, board, alt_text, link. Rows without
              scheduled_date are auto-assigned this account's next available
              posting-time slots. Up to {MAX_ROWS_PER_SUBMISSION} rows per
              upload.
            </div>

            <input
              type="file"
              accept=".csv"
              onChange={onFileSelected}
              className="text-[13px]"
            />

            {parsedRows.length > 0 && (
              <div className="flex flex-col gap-[8px]">
                <div className="grid grid-cols-[2fr,100px,120px,1fr] gap-[10px] text-[12px] text-customColor18 px-1">
                  <div>Content</div>
                  <div>Board</div>
                  <div>Date</div>
                  <div>Validation</div>
                </div>
                {parsedRows.map((row, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-[2fr,100px,120px,1fr] gap-[10px] items-center border border-newTableBorder bg-sixth rounded p-2"
                  >
                    <div className="truncate" title={row.content}>
                      {row.content || '(empty)'}
                    </div>
                    <div className="truncate">{row.boardId || '—'}</div>
                    <div className="text-[12px]">
                      {row.scheduledDate || 'auto'}
                    </div>
                    <div className="text-[12px]">
                      {row.validationError ? (
                        <span className="text-red-400">{row.validationError}</span>
                      ) : (
                        <span className="text-green-400">OK</span>
                      )}
                    </div>
                  </div>
                ))}

                <div className="flex items-center gap-3">
                  <div>
                    {validRows.length}/{parsedRows.length} rows valid
                  </div>
                  <Button
                    disabled={submitting || validRows.length === 0}
                    loading={submitting}
                    onClick={onSubmit}
                  >
                    Schedule {validRows.length} pin(s)
                  </Button>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <div className="text-lg font-semibold">Queue status</div>
              <div className="border border-newTableBorder bg-sixth rounded p-3">
                Queued: {queueData?.queued ?? 0} · Scheduled:{' '}
                {queueData?.done ?? 0} · Failed: {queueData?.failed.length ?? 0}{' '}
                · Total submitted: {queueData?.totalEverSubmitted ?? 0}
              </div>
            </div>

            {queueData && queueData.items.length > 0 && (
              <div className="flex flex-col gap-[8px]">
                <div className="grid grid-cols-[2fr,100px,1fr,120px,2fr] gap-[10px] text-[12px] text-customColor18 px-1">
                  <div>Content</div>
                  <div>Board</div>
                  <div>Publish date</div>
                  <div>Status</div>
                  <div>Error / Actions</div>
                </div>
                {queueData.items.map((item) => (
                  <div
                    key={item.id}
                    className="grid grid-cols-[2fr,100px,1fr,120px,2fr] gap-[10px] items-center border border-newTableBorder bg-sixth rounded p-2"
                  >
                    <div className="truncate" title={item.content}>
                      {item.content}
                    </div>
                    <div className="truncate">{item.boardId}</div>
                    <div className="text-[12px]">
                      {new Date(item.assignedPublishDate).toLocaleString()}
                    </div>
                    <div
                      className={clsx(
                        item.status === 'SCHEDULED' && 'text-green-400',
                        item.status === 'FAILED' && 'text-red-400',
                        item.status === 'PENDING' && 'text-customColor18'
                      )}
                    >
                      {item.status === 'SCHEDULED'
                        ? 'Scheduled'
                        : item.status === 'FAILED'
                        ? 'Failed'
                        : 'Pending'}
                    </div>
                    <div className="flex items-center gap-2 text-[12px]">
                      {item.status === 'FAILED' && (
                        <>
                          <span
                            className="text-red-400 truncate"
                            title={item.errorMessage || ''}
                          >
                            {item.errorMessage}
                          </span>
                          <Button
                            secondary={true}
                            innerClassName="!px-[10px] text-[12px]"
                            className="!h-[28px] !px-[10px]"
                            onClick={() => onRetry(item.id)}
                          >
                            Retry
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
};
