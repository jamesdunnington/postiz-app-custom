'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { orderBy } from 'lodash';
import clsx from 'clsx';
import Image from 'next/image';
import useCookie from 'react-use-cookie';
import copy from 'copy-to-clipboard';
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

interface BoardRow {
  key: string;
  name: string;
  description: string;
  isPrivate: boolean;
  boardId?: string;
  error?: string;
  creating?: boolean;
}

interface BoardCreateResult {
  name: string;
  boardId?: string;
  error?: string;
}

const DEFAULT_ROW_COUNT = 10;
// Matches the backend's @ArrayMaxSize(50) on PinterestBoardCreateDto.
const MAX_ROW_COUNT = 50;

let rowKeySeed = 0;
function makeEmptyRow(): BoardRow {
  rowKeySeed += 1;
  return {
    key: `row-${rowKeySeed}`,
    name: '',
    description: '',
    isPrivate: false,
  };
}
function makeEmptyRows(count: number): BoardRow[] {
  return Array.from({ length: count }, () => makeEmptyRow());
}

export const PinterestBoardCreationComponent = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const [collapseMenu, setCollapseMenu] = useCookie('collapseMenu', '0');
  const [selectedIntegrationId, setSelectedIntegrationId] = useState('');
  const [rowCountInput, setRowCountInput] = useState(String(DEFAULT_ROW_COUNT));
  const [rows, setRows] = useState<BoardRow[]>(() =>
    makeEmptyRows(DEFAULT_ROW_COUNT)
  );
  const [submitting, setSubmitting] = useState(false);

  const rowCount = useMemo(() => {
    const parsed = parseInt(rowCountInput, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_ROW_COUNT;
    return Math.min(MAX_ROW_COUNT, Math.max(1, parsed));
  }, [rowCountInput]);

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

  // Switching accounts starts a fresh table — board IDs are account-specific.
  useEffect(() => {
    setRows(makeEmptyRows(rowCount));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIntegrationId]);

  const onRowCountBlur = useCallback(() => {
    setRowCountInput(String(rowCount));
    setRows((prev) => {
      if (rowCount > prev.length) {
        return [...prev, ...makeEmptyRows(rowCount - prev.length)];
      }
      if (rowCount < prev.length) {
        const lastCreatedIndex = prev.reduce(
          (max, r, i) => (r.boardId ? i : max),
          -1
        );
        const targetLength = Math.max(rowCount, lastCreatedIndex + 1, 1);
        return prev.slice(0, targetLength);
      }
      return prev;
    });
  }, [rowCount]);

  const updateRow = useCallback(
    (index: number, patch: Partial<BoardRow>) => {
      setRows((prev) =>
        prev.map((r, i) => (i === index ? { ...r, ...patch } : r))
      );
    },
    []
  );

  const onClearAll = useCallback(() => {
    setRows(makeEmptyRows(rowCount));
  }, [rowCount]);

  const copyBoardId = useCallback(
    (boardId: string) => {
      copy(boardId);
      toaster.show('Board ID copied to clipboard', 'success');
    },
    [toaster]
  );

  const submitRows = useCallback(
    async (indices: number[]) => {
      if (!selectedIntegrationId) {
        toaster.show('Select a Pinterest account first', 'warning');
        return;
      }

      const toSubmit = indices
        .map((i) => ({ i, row: rows[i] }))
        .filter(({ row }) => row && row.name.trim());

      if (toSubmit.length === 0) {
        toaster.show('Fill in at least one board name', 'warning');
        return;
      }

      toSubmit.forEach(({ i }) => updateRow(i, { creating: true, error: undefined }));

      try {
        const response = await fetch('/pinterest-boards/create', {
          method: 'POST',
          body: JSON.stringify({
            integrationId: selectedIntegrationId,
            boards: toSubmit.map(({ row }) => ({
              name: row.name.trim(),
              description: row.description.trim() || undefined,
              isPrivate: row.isPrivate,
            })),
          }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({}) as any);
          toSubmit.forEach(({ i }) =>
            updateRow(i, { creating: false, error: 'Request failed' })
          );
          toaster.show(body.message || 'Failed to create boards', 'warning');
          return;
        }

        const results: BoardCreateResult[] = await response.json();
        toSubmit.forEach(({ i }, resultIndex) => {
          const result = results[resultIndex];
          updateRow(i, {
            creating: false,
            boardId: result?.boardId,
            error: result?.boardId ? undefined : result?.error || 'Failed',
          });
        });

        const successCount = results.filter((r) => r.boardId).length;
        toaster.show(
          `${successCount}/${toSubmit.length} board(s) created`,
          successCount === toSubmit.length ? 'success' : 'warning'
        );
      } catch (err) {
        toSubmit.forEach(({ i }) =>
          updateRow(i, { creating: false, error: 'Request failed' })
        );
        toaster.show('Failed to create boards', 'warning');
      }
    },
    [rows, selectedIntegrationId, fetch, toaster, updateRow]
  );

  const onCreateAll = useCallback(async () => {
    setSubmitting(true);
    try {
      await submitRows(
        rows
          .map((_, i) => i)
          .filter((i) => !rows[i].boardId && rows[i].name.trim())
      );
    } finally {
      setSubmitting(false);
    }
  }, [rows, submitRows]);

  const onRetryRow = useCallback(
    (index: number) => {
      submitRows([index]);
    },
    [submitRows]
  );

  const pendingCount = rows.filter((r) => !r.boardId && r.name.trim()).length;

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
        <div className="text-xl font-semibold">Pinterest Board Creation</div>

        {pinterestIntegrations.length === 0 && (
          <div>Connect a Pinterest account first to use this tool.</div>
        )}

        {pinterestIntegrations.length > 0 && !selectedIntegrationId && (
          <div>Select a Pinterest account from the channels on the left.</div>
        )}

        {selectedIntegrationId && (
          <>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="max-w-[220px]">
                <Input
                  label="Number of boards"
                  name="rowCount"
                  type="number"
                  disableForm={true}
                  removeError={true}
                  min={1}
                  max={MAX_ROW_COUNT}
                  value={rowCountInput}
                  onChange={(e) => setRowCountInput(e.target.value)}
                  onBlur={onRowCountBlur}
                />
              </div>
              <Button secondary={true} onClick={onClearAll}>
                Clear all
              </Button>
              <Button
                disabled={submitting || pendingCount === 0}
                loading={submitting}
                onClick={onCreateAll}
              >
                Create Boards ({pendingCount})
              </Button>
            </div>

            <div className="text-[12px] text-customColor18">
              Boards are created one at a time through Pinterest's shared
              rate-limited queue — the same one pin deletion uses — so a
              large batch (or one running alongside pin deletion) may take a
              little while.
            </div>

            <div className="flex flex-col gap-[8px]">
              <div className="grid grid-cols-[2fr,2fr,80px,220px] gap-[10px] text-[12px] text-customColor18 px-1">
                <div>Board name</div>
                <div>Description</div>
                <div>Private</div>
                <div>Board ID</div>
              </div>

              {rows.map((row, index) => (
                <div
                  key={row.key}
                  className="grid grid-cols-[2fr,2fr,80px,220px] gap-[10px] items-center"
                >
                  <Input
                    label=""
                    name={`board-name-${row.key}`}
                    disableForm={true}
                    removeError={true}
                    placeholder={`Board ${index + 1} name`}
                    value={row.name}
                    disabled={!!row.boardId}
                    onChange={(e) => updateRow(index, { name: e.target.value })}
                  />
                  <Input
                    label=""
                    name={`board-description-${row.key}`}
                    disableForm={true}
                    removeError={true}
                    placeholder="Optional description"
                    value={row.description}
                    disabled={!!row.boardId}
                    onChange={(e) =>
                      updateRow(index, { description: e.target.value })
                    }
                  />
                  <Slider
                    value={row.isPrivate ? 'on' : 'off'}
                    onChange={(v) =>
                      updateRow(index, { isPrivate: v === 'on' })
                    }
                  />
                  <div className="flex items-center gap-2 text-[13px] min-w-0">
                    {row.boardId ? (
                      <>
                        <span className="truncate" title={row.boardId}>
                          {row.boardId}
                        </span>
                        <button
                          type="button"
                          onClick={() => copyBoardId(row.boardId!)}
                          title="Copy board ID"
                          className="shrink-0 hover:opacity-70 cursor-pointer"
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="16"
                            height="16"
                            viewBox="0 0 16 16"
                            fill="none"
                          >
                            <rect
                              x="5"
                              y="5"
                              width="9"
                              height="9"
                              rx="1.5"
                              stroke="currentColor"
                              strokeWidth="1.3"
                            />
                            <path
                              d="M11 5V3.5C11 2.67157 10.3284 2 9.5 2H3.5C2.67157 2 2 2.67157 2 3.5V9.5C2 10.3284 2.67157 11 3.5 11H5"
                              stroke="currentColor"
                              strokeWidth="1.3"
                            />
                          </svg>
                        </button>
                      </>
                    ) : row.creating ? (
                      <span className="text-customColor18">Creating…</span>
                    ) : row.error ? (
                      <>
                        <span
                          className="text-red-400 truncate"
                          title={row.error}
                        >
                          {row.error}
                        </span>
                        <Button
                          secondary={true}
                          innerClassName="!px-[10px] text-[12px]"
                          className="!h-[28px] !px-[10px]"
                          onClick={() => onRetryRow(index)}
                        >
                          Retry
                        </Button>
                      </>
                    ) : (
                      <span className="text-customColor18">—</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
};
