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
import { Slider } from '@gitroom/react/form/slider';
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

interface PinterestBoardOption {
  id: string;
  name: string;
}

interface PinterestBoardDeleteQueueItem {
  id: string;
  boardId: string;
  boardName: string;
  status: 'PENDING' | 'REMOVED' | 'FAILED';
  scheduledFor: string | null;
  errorMessage: string | null;
}

interface PinterestBoardDeleteQueueSummary {
  queued: number;
  done: number;
  failed: {
    id: string;
    boardId: string;
    boardName: string;
    errorMessage: string | null;
  }[];
  totalEverSubmitted: number;
  nextRunAt: string | null;
  lastCompletionAt: string | null;
  items: PinterestBoardDeleteQueueItem[];
}

const MAX_BOARDS_PER_SUBMISSION = 25;

export const PinterestBoardDeleteComponent = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [collapseMenu, setCollapseMenu] = useCookie('collapseMenu', '0');
  const [selectedIntegrationId, setSelectedIntegrationId] = useState('');
  const [search, setSearch] = useState('');
  const [selectedBoardIds, setSelectedBoardIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Persists in-progress checkbox selections (per Pinterest account) across
  // page refreshes — nothing is queued server-side until "Queue for
  // deletion" is clicked, so without this a refresh silently loses them.
  const [selectionCookieRaw, setSelectionCookieRaw] = useCookie(
    'pinterestBoardDeleteSelection',
    '{}'
  );
  const selectionMap: Record<string, string[]> = useMemo(() => {
    try {
      return JSON.parse(selectionCookieRaw || '{}');
    } catch {
      return {};
    }
  }, [selectionCookieRaw]);
  const persistSelection = useCallback(
    (integrationId: string, boardIds: string[]) => {
      if (!integrationId) return;
      setSelectionCookieRaw(
        JSON.stringify({ ...selectionMap, [integrationId]: boardIds })
      );
    },
    [selectionMap, setSelectionCookieRaw]
  );

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
    setSelectedBoardIds(selectionMap[selectedIntegrationId] || []);
    setSearch('');
    // Intentionally reacting only to the account switching, not to
    // selectionMap itself — this effect's job is "load on switch", not
    // "stay in sync," which would clobber persistSelection's own writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIntegrationId]);

  const { data: boardsData } = useSWR<PinterestBoardOption[]>(
    selectedIntegrationId ? `pinterest-boards-${selectedIntegrationId}` : null,
    async () => {
      const response = await fetch('/integrations/function', {
        method: 'POST',
        body: JSON.stringify({
          name: 'boards',
          id: selectedIntegrationId,
          data: { includeArchived: true },
        }),
      });
      return response.json();
    }
  );

  const { data: queueData, mutate: mutateQueue } = useSWR<
    PinterestBoardDeleteQueueSummary
  >(
    selectedIntegrationId
      ? `pinterest-board-delete-queue-${selectedIntegrationId}`
      : null,
    async () =>
      (
        await fetch(
          `/pinterest-board-delete/queue?integrationId=${selectedIntegrationId}`
        )
      ).json(),
    { refreshInterval: 7000 }
  );

  const pendingBoardIds = useMemo(
    () =>
      new Set(
        (queueData?.items || [])
          .filter((i) => i.status === 'PENDING')
          .map((i) => i.boardId)
      ),
    [queueData]
  );

  const filteredBoards = useMemo(
    () =>
      (boardsData || []).filter((b) =>
        b.name.toLowerCase().includes(search.toLowerCase())
      ),
    [boardsData, search]
  );

  const toggleBoard = useCallback(
    (boardId: string, on: boolean) => {
      setSelectedBoardIds((prev) => {
        let next = prev;
        if (on) {
          if (!prev.includes(boardId) && prev.length < MAX_BOARDS_PER_SUBMISSION) {
            next = [...prev, boardId];
          }
        } else {
          next = prev.filter((id) => id !== boardId);
        }
        persistSelection(selectedIntegrationId, next);
        return next;
      });
    },
    [selectedIntegrationId, persistSelection]
  );

  const onQueueForDeletion = useCallback(async () => {
    if (!selectedIntegrationId || selectedBoardIds.length === 0) {
      return;
    }
    const boards = selectedBoardIds
      .map((boardId) => {
        const board = (boardsData || []).find((b) => b.id === boardId);
        return board ? { boardId: board.id, boardName: board.name } : null;
      })
      .filter((b): b is { boardId: string; boardName: string } => !!b);

    setSubmitting(true);
    try {
      const response = await fetch('/pinterest-board-delete/batches', {
        method: 'POST',
        body: JSON.stringify({ integrationId: selectedIntegrationId, boards }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}) as any);
        toaster.show(body.message || 'Failed to queue boards for deletion', 'warning');
        return;
      }

      setSelectedBoardIds([]);
      persistSelection(selectedIntegrationId, []);
      toaster.show('Boards queued for deletion', 'success');
      mutateQueue();
    } finally {
      setSubmitting(false);
    }
  }, [
    selectedIntegrationId,
    selectedBoardIds,
    boardsData,
    fetch,
    toaster,
    mutateQueue,
    persistSelection,
  ]);

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
        <div className="text-xl font-semibold">Pinterest Board Deletion</div>

        {pinterestIntegrations.length === 0 && (
          <div>Connect a Pinterest account first to use this tool.</div>
        )}

        {pinterestIntegrations.length > 0 && !selectedIntegrationId && (
          <div>Select a Pinterest account from the channels on the left.</div>
        )}

        {selectedIntegrationId && (
          <>
            <div className="text-[12px] text-customColor18">
              Boards are deleted one at a time, every 300-320 minutes
              (randomized) per account — including archived boards.
              Submitting more boards adds them to this same ongoing queue.
              There is no retry for a failed deletion.
            </div>

            <div className="max-w-[320px]">
              <Input
                label="Search boards"
                name="boardSearch"
                disableForm={true}
                removeError={true}
                placeholder="Filter by board name"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {!boardsData && <div>Loading boards…</div>}
            {boardsData && boardsData.length === 0 && (
              <div>No boards found on this account.</div>
            )}

            {boardsData && boardsData.length > 0 && (
              <div className="flex flex-col gap-[6px] max-h-[320px] overflow-y-auto border border-newTableBorder rounded p-2">
                {filteredBoards.map((board) => {
                  const alreadyQueued = pendingBoardIds.has(board.id);
                  const selected = selectedBoardIds.includes(board.id);
                  return (
                    <div
                      key={board.id}
                      className="flex items-center gap-3 px-1 py-1"
                    >
                      <Slider
                        value={selected ? 'on' : 'off'}
                        onChange={(v) => toggleBoard(board.id, v === 'on')}
                      />
                      <div
                        className={clsx(
                          'flex-1 truncate',
                          alreadyQueued && 'opacity-40'
                        )}
                        title={board.name}
                      >
                        {board.name}
                      </div>
                      {alreadyQueued && (
                        <div className="text-[12px] text-customColor18">
                          Already queued
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex items-center gap-3">
              <div>
                {selectedBoardIds.length}/{MAX_BOARDS_PER_SUBMISSION} selected
              </div>
              <Button
                disabled={submitting || selectedBoardIds.length === 0}
                loading={submitting}
                onClick={onQueueForDeletion}
              >
                Queue for deletion ({selectedBoardIds.length})
              </Button>
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
            </div>

            {queueData && queueData.items.length > 0 && (
              <div className="flex flex-col gap-[8px]">
                <div className="grid grid-cols-[2fr,120px,1fr,2fr] gap-[10px] text-[12px] text-customColor18 px-1">
                  <div>Board name</div>
                  <div>Status</div>
                  <div>Scheduled / completed</div>
                  <div>Error</div>
                </div>
                {queueData.items.map((item) => (
                  <div
                    key={item.id}
                    className="grid grid-cols-[2fr,120px,1fr,2fr] gap-[10px] items-center border border-newTableBorder bg-sixth rounded p-2"
                  >
                    <div className="truncate" title={item.boardName}>
                      {item.boardName}
                    </div>
                    <div
                      className={clsx(
                        item.status === 'REMOVED' && 'text-green-400',
                        item.status === 'FAILED' && 'text-red-400',
                        item.status === 'PENDING' && 'text-customColor18'
                      )}
                    >
                      {item.status === 'REMOVED'
                        ? 'Deleted'
                        : item.status === 'FAILED'
                        ? 'Failed'
                        : 'Pending'}
                    </div>
                    <div className="text-[12px]">
                      {item.scheduledFor
                        ? new Date(item.scheduledFor).toLocaleString()
                        : '—'}
                    </div>
                    <div className="text-[12px] text-red-400 truncate" title={item.errorMessage || ''}>
                      {item.errorMessage || ''}
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
