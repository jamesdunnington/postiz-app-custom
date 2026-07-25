import { FC, useCallback, useMemo, useState } from 'react';
import { Integration } from '@prisma/client';
import useSWR from 'swr';
import clsx from 'clsx';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { ChartSocial } from '@gitroom/frontend/components/analytics/chart-social';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

const COMPARE_COLORS = ['#8b5cf6', '#14b8a6'];
const INACTIVE_DOT_COLOR = '#6b7280';

type PinSortField = 'impressions' | 'outboundClicks' | 'saves' | 'ctr';

export const RenderAnalytics: FC<{
  integration: Integration & { identifier?: string };
  date: number;
  customStartDate?: string;
  customEndDate?: string;
}> = (props) => {
  const { integration, date, customStartDate, customEndDate } = props;
  const [loading, setLoading] = useState(true);
  const [selectedMetrics, setSelectedMetrics] = useState<number[]>([0]);
  const [exporting, setExporting] = useState(false);
  const [pinSortField, setPinSortField] = useState<PinSortField>('ctr');
  const [pinSortDir, setPinSortDir] = useState<'asc' | 'desc'>('desc');
  const fetch = useFetch();

  const queryString = useMemo(() => {
    if (date === -1 && customStartDate && customEndDate) {
      return `date=-1&startDate=${customStartDate}&endDate=${customEndDate}`;
    }
    return `date=${date}`;
  }, [date, customStartDate, customEndDate]);

  const swrKey = useMemo(() => {
    if (date === -1 && customStartDate && customEndDate) {
      return `/analytics-${integration?.id}-custom-${customStartDate}-${customEndDate}`;
    }
    return `/analytics-${integration?.id}-${date}`;
  }, [integration, date, customStartDate, customEndDate]);

  const load = useCallback(async () => {
    setLoading(true);
    const load = (
      await fetch(`/analytics/${integration.id}?${queryString}`)
    ).json();
    setLoading(false);
    return load;
  }, [integration, queryString]);

  const { data } = useSWR(swrKey, load, {
    refreshInterval: 0,
    refreshWhenHidden: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    refreshWhenOffline: false,
    revalidateOnMount: true,
  });

  const isPinterest = (integration as any).identifier === 'pinterest';

  const loadPinterestTops = useCallback(async () => {
    if (!isPinterest) return null;
    return (
      await fetch(`/analytics/${integration.id}/pinterest-tops?${queryString}`)
    ).json();
  }, [integration, isPinterest, queryString]);

  const { data: pinterestTops } = useSWR(
    isPinterest ? `/pinterest-tops-${integration?.id}-${swrKey}` : null,
    loadPinterestTops,
    {
      refreshInterval: 0,
      refreshWhenHidden: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      refreshWhenOffline: false,
      revalidateOnMount: true,
    }
  );

  const aggregatedTopPins = useMemo(() => {
    const pins = pinterestTops?.topPins || [];
    const groups = new Map<
      string,
      { url: string; impressions: number; outboundClicks: number; saves: number }
    >();

    pins.forEach((pin: any) => {
      const key = pin.destinationUrl || pin.url || pin.id;
      if (!key) return;
      const existing = groups.get(key);
      if (existing) {
        existing.impressions += pin.impressions || 0;
        existing.outboundClicks += pin.outboundClicks || 0;
        existing.saves += pin.saves || 0;
      } else {
        groups.set(key, {
          url: pin.destinationUrl || pin.url || '',
          impressions: pin.impressions || 0,
          outboundClicks: pin.outboundClicks || 0,
          saves: pin.saves || 0,
        });
      }
    });

    const rows = Array.from(groups.values()).map((row) => ({
      ...row,
      ctr: row.impressions ? (row.outboundClicks / row.impressions) * 100 : 0,
    }));

    return rows.sort((a, b) => {
      const diff = (a[pinSortField] || 0) - (b[pinSortField] || 0);
      return pinSortDir === 'asc' ? diff : -diff;
    });
  }, [pinterestTops, pinSortField, pinSortDir]);

  const togglePinSort = useCallback(
    (field: PinSortField) => {
      if (pinSortField === field) {
        setPinSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setPinSortField(field);
        setPinSortDir('desc');
      }
    },
    [pinSortField]
  );

  const toggleMetric = useCallback((index: number) => {
    setSelectedMetrics((prev) => {
      if (prev.includes(index)) {
        // keep at least one metric selected
        return prev.length === 1 ? prev : prev.filter((i) => i !== index);
      }
      if (prev.length >= 2) {
        // drop the oldest selection, keep the most recent 2
        return [prev[1], index];
      }
      return [...prev, index];
    });
  }, []);

  const refreshChannel = useCallback(
    (
        integration: Integration & {
          identifier: string;
        }
      ) =>
      async () => {
        const { url } = await (
          await fetch(
            `/integrations/social/${integration.identifier}?refresh=${integration.internalId}`,
            {
              method: 'GET',
            }
          )
        ).json();
        window.location.href = url;
      },
    []
  );

  const t = useT();

  const total = useMemo(() => {
    return data?.map((p: any) => {
      const value =
        (p?.data.reduce((acc: number, curr: any) => acc + (parseFloat(curr.total) || 0), 0) || 0) /
        (p.average ? p.data.length : 1);
      if (p.average) {
        return value.toFixed(2) + '%';
      }
      return Math.round(value).toLocaleString();
    });
  }, [data]);

  const formatNumber = useCallback((num: number) => {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'm';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'k';
    }
    return num.toString();
  }, []);

  const handleExport = useCallback(async () => {
    if (!data || exporting) return;
    setExporting(true);
    try {
      const rows: string[] = [];
      // Header row
      const headers = ['Date', ...data.map((m: any) => m.label)];
      rows.push(headers.join(','));

      // Collect all unique dates from metric data
      const allDates = new Set<string>();
      data.forEach((metric: any) => {
        metric.data?.forEach((d: any) => allDates.add(d.date));
      });
      const sortedDates = Array.from(allDates).sort();

      // Data rows
      for (const dateStr of sortedDates) {
        const row = [dateStr];
        for (const metric of data) {
          const point = metric.data?.find((d: any) => d.date === dateStr);
          row.push(point ? String(point.total) : '0');
        }
        rows.push(row.join(','));
      }

      // Summary row
      const summaryRow = ['TOTAL'];
      for (let i = 0; i < data.length; i++) {
        summaryRow.push(total[i] || '0');
      }
      rows.push(summaryRow.join(','));

      const csvContent = rows.join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `analytics-${integration.name || integration.id}-${
        date === -1 ? `${customStartDate}_${customEndDate}` : `${date}days`
      }.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [data, total, integration, date, customStartDate, customEndDate, exporting]);

  const dateLabel = useMemo(() => {
    if (date === -1 && customStartDate && customEndDate) {
      return `${customStartDate} to ${customEndDate}`;
    }
    return `${date} days`;
  }, [date, customStartDate, customEndDate]);

  if (loading) {
    return (
      <>
        <LoadingComponent />
      </>
    );
  }

  if (data?.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <div className="text-lg mb-4">
          {t(
            'this_channel_needs_to_be_refreshed',
            'This channel needs to be refreshed,'
          )}
        </div>
        <div
          className="text-purple-500 underline hover:font-bold cursor-pointer"
          onClick={refreshChannel(integration as any)}
        >
          {t('click_here_to_refresh', 'click here to refresh')}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Export Button */}
      <div className="flex justify-end">
        <button
          onClick={handleExport}
          disabled={exporting || !data}
          className="flex items-center gap-2 px-4 py-2 bg-btnSimple text-btnText rounded-md hover:opacity-80 transition-opacity disabled:opacity-40 text-sm font-medium"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          {exporting ? t('exporting', 'Exporting...') : t('export_csv', 'Export CSV')}
        </button>
      </div>

      {/* Analytics Dashboard Section */}
      <div>
        <h2 className="text-2xl font-semibold mb-4">
          {t('analytics_dashboard', 'Analytics Dashboard')}
        </h2>

        {/* Stat Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {data?.map((metric: any, index: number) => {
            const isAverage = metric.average;
            const totalValue = parseFloat(total[index]?.toString().replace(/,/g, '').replace(/%/g, '') || '0');
            const slot = selectedMetrics.indexOf(index);
            const active = slot !== -1;
            const color = active ? COMPARE_COLORS[slot] : undefined;

            return (
              <button
                key={`metric-${index}`}
                onClick={() => toggleMetric(index)}
                className={clsx(
                  'text-left bg-newTableHeader rounded-lg overflow-hidden border transition-all',
                  active
                    ? 'border-current'
                    : 'border-customColor6 hover:border-purple-500'
                )}
                style={active ? { color } : undefined}
              >
                <div
                  className="h-[3px]"
                  style={{ backgroundColor: color || INACTIVE_DOT_COLOR }}
                />
                <div className="p-4">
                  <div className="text-xs font-medium text-gray-400 mb-1">
                    {metric.label}
                  </div>
                  <div className="text-2xl font-bold text-textColor">
                    {isAverage ? totalValue.toFixed(2) + '%' : formatNumber(totalValue)}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Performance Over Time Section */}
      <div className="bg-newBgColorInner rounded-xl p-6 border border-customColor6">
        {(() => {
          const chartSeries = selectedMetrics
            .map((index, slot) => {
              const metric = data?.[index];
              if (!metric) return null;
              return {
                label: metric.label as string,
                color: COMPARE_COLORS[slot],
                data: metric.data,
              };
            })
            .filter((s): s is { label: string; color: string; data: any } => !!s);

          if (!chartSeries.length) return null;

          const titleLabel = chartSeries.map((s) => s.label).join(` ${t('vs', 'vs')} `);

          return (
            <>
              <div className="mb-4">
                <h2 className="text-xl font-semibold mb-1">
                  {titleLabel} {t('over_time', 'over time')}
                </h2>
                <p className="text-sm text-gray-400">
                  {t('view_how_your_metric_has_changed_over_time', 'View how your')}{' '}
                  {titleLabel.toLowerCase()}{' '}
                  {t('has_changed_over_time', 'has changed over time')}
                </p>
              </div>

              {/* Metric Pills */}
              <div className="flex flex-wrap gap-2 mb-6">
                {data?.map((m: any, index: number) => {
                  const slot = selectedMetrics.indexOf(index);
                  const active = slot !== -1;
                  const color = active ? COMPARE_COLORS[slot] : undefined;
                  return (
                    <button
                      key={`pill-${index}`}
                      onClick={() => toggleMetric(index)}
                      className={clsx(
                        'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm border transition-colors',
                        active
                          ? 'text-white border-transparent'
                          : 'border-customColor6 text-gray-400 hover:text-textColor'
                      )}
                      style={active ? { backgroundColor: color } : undefined}
                    >
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: active ? '#fff' : INACTIVE_DOT_COLOR }}
                      />
                      {m.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-gray-500 mb-4">
                {t(
                  'select_up_to_two_metrics_to_compare',
                  'Select up to two metrics to overlay and compare.'
                )}
              </p>

              <div className="h-[320px] relative">
                <ChartSocial series={chartSeries} key={`chart-social-${selectedMetrics.join('-')}`} />
              </div>
            </>
          );
        })()}
      </div>

      {/* Pinterest Top Pins Section */}
      {isPinterest && pinterestTops && pinterestTops.topPins?.length > 0 && (
        <div className="bg-newBgColorInner rounded-xl p-6 border border-customColor6">
          <div className="mb-4">
            <h2 className="text-xl font-semibold mb-1">{t('top_pins', 'Top Pins')}</h2>
            <p className="text-sm text-gray-400">
              {t(
                'top_pins_description',
                'Aggregated by destination URL for the selected time frame, ranked by outbound click-through rate. Click a column header to sort.'
              )}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-customColor6">
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-400 whitespace-nowrap">
                    #
                  </th>
                  <th className="px-3 py-3 text-left text-xs font-medium text-gray-400 whitespace-nowrap">
                    {t('url', 'URL')}
                  </th>
                  {(
                    [
                      ['impressions', t('impressions', 'Impressions')],
                      ['outboundClicks', t('outbound_clicks', 'Outbound Clicks')],
                      ['saves', t('saves', 'Saves')],
                      ['ctr', t('click_through_rate', 'Click Through Rate')],
                    ] as [PinSortField, string][]
                  ).map(([field, label]) => (
                    <th
                      key={field}
                      onClick={() => togglePinSort(field)}
                      className="px-3 py-3 text-right text-xs font-medium text-gray-400 whitespace-nowrap cursor-pointer select-none hover:text-textColor"
                    >
                      <span className="inline-flex items-center gap-1">
                        {label}
                        {pinSortField === field && (pinSortDir === 'asc' ? '▲' : '▼')}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {aggregatedTopPins.map((row, i: number) => (
                  <tr
                    key={row.url || i}
                    className="border-b border-customColor6 last:border-0 hover:bg-newTableHeader"
                  >
                    <td className="px-3 py-3 text-gray-400">{i + 1}</td>
                    <td className="px-3 py-3 max-w-[220px]">
                      {row.url ? (
                        <a
                          href={row.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-purple-400 hover:underline truncate block"
                        >
                          {row.url}
                        </a>
                      ) : (
                        <span className="text-gray-500">
                          {t('untitled_pin', 'Untitled Pin')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right font-medium whitespace-nowrap">
                      {formatNumber(row.impressions || 0)}
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {formatNumber(row.outboundClicks || 0)}
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {formatNumber(row.saves || 0)}
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {row.ctr.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
