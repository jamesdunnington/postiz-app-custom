import { FC, useCallback, useMemo, useState } from 'react';
import { Integration } from '@prisma/client';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { ChartSocial } from '@gitroom/frontend/components/analytics/chart-social';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { Select } from '@gitroom/react/form/select';

export const RenderAnalytics: FC<{
  integration: Integration;
  date: number;
}> = (props) => {
  const { integration, date } = props;
  const [loading, setLoading] = useState(true);
  const [selectedMetric1, setSelectedMetric1] = useState<number>(0);
  const [selectedMetric2, setSelectedMetric2] = useState<number>(1);
  const fetch = useFetch();
  
  const load = useCallback(async () => {
    setLoading(true);
    const load = (
      await fetch(`/analytics/${integration.id}?date=${date}`)
    ).json();
    setLoading(false);
    return load;
  }, [integration, date]);
  
  const { data } = useSWR(`/analytics-${integration?.id}-${date}`, load, {
    refreshInterval: 0,
    refreshWhenHidden: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    refreshWhenOffline: false,
    revalidateOnMount: true,
  });
  
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
      {/* Overall Performance Section - Pinterest Style */}
      <div className="bg-newBgColorInner rounded-xl p-6 border border-customColor6">
        <div className="mb-6">
          <h2 className="text-2xl font-semibold mb-1">Overall performance</h2>
          <p className="text-sm text-gray-400">
            Percent changes are compared to {date} days before the selected date range. Metrics updated in real-time except for audience.
          </p>
        </div>
        
        {/* Metrics Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {data?.map((metric: any, index: number) => {
            const totalValue = parseFloat(total[index]?.toString().replace(/,/g, '') || '0');
            const percentageChange = metric.percentageChange || 0;
            const isPositive = percentageChange >= 0;
            
            return (
              <div
                key={`metric-${index}`}
                className="bg-newTableHeader rounded-lg p-4 hover:bg-opacity-80 transition-all cursor-pointer border border-transparent hover:border-purple-500"
              >
                <div className="flex items-center gap-2 mb-3">
                  <svg
                    className="w-5 h-5 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <circle cx="12" cy="12" r="2" />
                  </svg>
                  <h3 className="text-sm font-medium text-gray-300">{metric.label}</h3>
                </div>
                
                {/* Value */}
                <div className="text-3xl font-bold mb-2">{formatNumber(totalValue)}</div>
                
                {/* Percentage Change */}
                <div className={`flex items-center gap-1 text-sm font-medium ${
                  isPositive ? 'text-green-500' : 'text-red-500'
                }`}>
                  {isPositive ? (
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M5.293 9.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L11 7.414V15a1 1 0 11-2 0V7.414L6.707 9.707a1 1 0 01-1.414 0z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M14.707 10.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L9 12.586V5a1 1 0 012 0v7.586l2.293-2.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                  <span>{Math.abs(percentageChange)}%</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Performance Over Time Section */}
      <div className="bg-newBgColorInner rounded-xl p-6 border border-customColor6">
        <div className="mb-6">
          <h2 className="text-2xl font-semibold mb-4">Performance over time</h2>
          
          {/* Metric Selectors */}
          <div className="flex flex-wrap gap-4 items-center">
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-400 font-medium">Metric</label>
              <div className="w-48">
                <Select
                  label=""
                  name="metric1"
                  disableForm={true}
                  hideErrors={true}
                  value={selectedMetric1}
                  onChange={(e) => setSelectedMetric1(+e.target.value)}
                >
                  {data?.map((metric: any, index: number) => (
                    <option key={`m1-${index}`} value={index}>
                      {metric.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="flex items-center gap-2 text-gray-500">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </div>

            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-400 font-medium">Metric</label>
              <div className="w-48">
                <Select
                  label=""
                  name="metric2"
                  disableForm={true}
                  hideErrors={true}
                  value={selectedMetric2}
                  onChange={(e) => setSelectedMetric2(+e.target.value)}
                >
                  {data?.map((metric: any, index: number) => (
                    <option key={`m2-${index}`} value={index}>
                      {metric.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </div>
        </div>

        {/* Charts Comparison */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[selectedMetric1, selectedMetric2].map((metricIndex, idx) => {
            const metric = data?.[metricIndex];
            if (!metric) return null;
            
            const totalValue = parseFloat(total[metricIndex]?.toString().replace(/,/g, '') || '0');
            
            return (
              <div
                key={`chart-${idx}`}
                className="bg-newTableHeader rounded-lg p-5 border border-customColor6"
              >
                <div className="mb-4">
                  <h3 className="text-lg font-semibold mb-1">{metric.label}</h3>
                  <div className="text-3xl font-bold text-purple-400">
                    {formatNumber(totalValue)}
                  </div>
                </div>
                
                <div className="h-[300px] relative">
                  <ChartSocial {...metric} key={`chart-social-${metricIndex}`} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
