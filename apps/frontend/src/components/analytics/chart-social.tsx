'use client';

import { FC, useEffect, useMemo, useRef } from 'react';
import DrawChart from 'chart.js/auto';
import { TotalList } from '@gitroom/frontend/components/analytics/stars.and.forks.interface';
import useCookie from 'react-use-cookie';
import dayjs from 'dayjs';

const hexToRgba = (hex: string, alpha: number) => {
  const bigint = parseInt(hex.replace('#', ''), 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export type ChartSeries = {
  label: string;
  color: string;
  data: TotalList[];
};

export const ChartSocial: FC<{
  series: ChartSeries[];
  showInOverview?: boolean;
}> = (props) => {
  const { series, showInOverview = false } = props;
  const [mode] = useCookie('mode', 'dark');
  const axisColor = mode === 'dark' ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.5)';

  // Use the first series' dates for the x-axis labels
  const list = useMemo(() => series[0]?.data || [], [series]);

  // Format dates for display - show fewer labels for longer periods to avoid crowding
  const formattedLabels = useMemo(() => {
    const dataLength = list.length;
    return list.map((row, index) => {
      const date = dayjs(row.date);

      // For overview charts (small), show minimal labels
      if (showInOverview) {
        return index === 0 || index === list.length - 1 ? date.format('MMM D') : '';
      }

      // For 7 days or less, show all dates
      if (dataLength <= 7) {
        return date.format('MMM D');
      }
      // For 8-30 days, show every 3rd date
      else if (dataLength <= 30) {
        return index % 3 === 0 || index === dataLength - 1 ? date.format('MMM D') : '';
      }
      // For 30-90 days, show every 7th date
      else {
        return index % 7 === 0 || index === dataLength - 1 ? date.format('MMM D') : '';
      }
    });
  }, [list, showInOverview]);

  const ref = useRef<any>(null);
  const chart = useRef<null | DrawChart>(null);

  useEffect(() => {
    if (!ref.current || !series.length) return;

    const ctx = ref.current.getContext('2d');
    const isComparing = series.length > 1;

    const datasets = series.map((s, index) => {
      const gradient = ctx.createLinearGradient(0, 0, 0, ref.current.height);
      gradient.addColorStop(0, hexToRgba(s.color, isComparing ? 0.25 : 0.5));
      gradient.addColorStop(1, hexToRgba(s.color, 0));

      return {
        borderColor: s.color,
        borderWidth: 2,
        label: s.label,
        backgroundColor: gradient,
        fill: true,
        tension: 0.4, // Smooth curves like Pinterest
        pointRadius: showInOverview ? 0 : 3,
        pointHoverRadius: showInOverview ? 0 : 5,
        pointBackgroundColor: s.color,
        // @ts-ignore
        data: s.data.map((row) => row.total),
        yAxisID: index === 0 ? 'y' : 'y1',
        // @ts-ignore
        segment: {
          borderDash: (segCtx: any) => {
            // Check if the current data point is tentative (dotted line for last 2 days like Pinterest)
            const dataPoint = s.data[segCtx.p0DataIndex];
            return dataPoint?.tentative ? [5, 5] : undefined;
          },
        },
      };
    });

    const scales: any = {
      y: {
        beginAtZero: true,
        display: !showInOverview,
        position: 'left',
        grid: {
          display: !showInOverview,
          color: mode === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
        },
        ticks: {
          color: isComparing ? series[0].color : axisColor,
        },
      },
      x: {
        display: !showInOverview,
        grid: {
          display: false,
        },
        ticks: {
          color: axisColor,
          maxRotation: 0,
          autoSkip: false,
        },
      },
    };

    if (isComparing) {
      scales.y1 = {
        beginAtZero: true,
        display: !showInOverview,
        position: 'right',
        grid: {
          drawOnChartArea: false,
        },
        ticks: {
          color: series[1].color,
        },
      };
    }

    chart.current = new DrawChart(ref.current!, {
      type: 'line',
      options: {
        maintainAspectRatio: false,
        responsive: true,
        interaction: {
          intersect: false,
          mode: 'index',
        },
        layout: {
          padding: {
            left: showInOverview ? 0 : 10,
            right: showInOverview ? 0 : 10,
            top: showInOverview ? 5 : 10,
            bottom: showInOverview ? 0 : 10,
          },
        },
        scales,
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            enabled: !showInOverview,
            backgroundColor: mode === 'dark' ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.9)',
            titleColor: mode === 'dark' ? '#fff' : '#000',
            bodyColor: mode === 'dark' ? '#fff' : '#000',
            borderColor: mode === 'dark' ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)',
            borderWidth: 1,
            padding: 10,
            displayColors: isComparing,
          },
        },
      },
      data: {
        labels: formattedLabels,
        // @ts-ignore
        datasets,
      },
    });

    return () => {
      chart?.current?.destroy();
    };
  }, [series, mode, formattedLabels, showInOverview, axisColor]);

  return <canvas className="w-full h-full" ref={ref} />;
};
