'use client';

import { FC, useEffect, useMemo, useRef } from 'react';
import DrawChart from 'chart.js/auto';
import { TotalList } from '@gitroom/frontend/components/analytics/stars.and.forks.interface';
import useCookie from 'react-use-cookie';
import dayjs from 'dayjs';

export const ChartSocial: FC<{
  data: TotalList[];
  showInOverview?: boolean;
}> = (props) => {
  const { data, showInOverview = false } = props;
  const [mode] = useCookie('mode', 'dark');
  
  // Use all data points for day-by-day display
  const list = useMemo(() => data, [data]);
  
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
    if (!ref.current) return;
    
    const gradient = ref.current
      .getContext('2d')
      .createLinearGradient(0, 0, 0, ref.current.height);
    gradient.addColorStop(0, 'rgb(90,46,203)');
    gradient.addColorStop(1, 'rgb(65, 38, 136, 1)');
    
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
        scales: {
          y: {
            beginAtZero: true,
            display: !showInOverview,
            grid: {
              display: !showInOverview,
              color: mode === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
            },
            ticks: {
              color: mode === 'dark' ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.5)',
            },
          },
          x: {
            display: !showInOverview,
            grid: {
              display: false,
            },
            ticks: {
              color: mode === 'dark' ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.5)',
              maxRotation: 0,
              autoSkip: false,
            },
          },
        },
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
            displayColors: false,
          },
        },
      },
      data: {
        labels: formattedLabels,
        datasets: [
          {
            borderColor: mode === 'dark' ? '#fff' : '#000',
            borderWidth: 2,
            // @ts-ignore
            label: 'Total',
            backgroundColor: gradient,
            fill: true,
            tension: 0.4, // Smooth curves like Pinterest
            pointRadius: showInOverview ? 0 : 3,
            pointHoverRadius: showInOverview ? 0 : 5,
            pointBackgroundColor: mode === 'dark' ? '#fff' : '#000',
            // @ts-ignore
            data: list.map((row) => row.total),
            // @ts-ignore
            segment: {
              borderDash: (ctx: any) => {
                // Check if the current data point is tentative (dotted line for last 2 days like Pinterest)
                const dataPoint = data[ctx.p0DataIndex];
                return dataPoint?.tentative ? [5, 5] : undefined;
              },
            },
          },
        ],
      },
    });
    
    return () => {
      chart?.current?.destroy();
    };
  }, [data, mode, formattedLabels, showInOverview]);
  
  return <canvas className="w-full h-full" ref={ref} />;
};
