'use client';

import { FC, useEffect, useRef } from 'react';
import DrawChart from 'chart.js/auto';
import {
  ForksList,
  StarsList,
} from '@gitroom/frontend/components/analytics/stars.and.forks.interface';
import dayjs from 'dayjs';
import { newDayjs } from '@gitroom/frontend/components/layout/set.timezone';
import useCookie from 'react-use-cookie';

export const Chart: FC<{
  list: StarsList[] | ForksList[];
}> = (props) => {
  const { list } = props;
  const [mode] = useCookie('mode', 'dark');
  const ref = useRef<any>(null);
  const chart = useRef<null | DrawChart>(null);
  
  useEffect(() => {
    // Use vibrant colors for better readability
    const lineColor = mode === 'dark' ? '#06b6d4' : '#0891b2'; // Cyan shades
    const pointColor = mode === 'dark' ? '#22d3ee' : '#0e7490'; // Complementary cyan
    
    const gradient = ref.current
      .getContext('2d')
      .createLinearGradient(0, 0, 0, ref.current.height);
    
    if (mode === 'dark') {
      // Dark mode: darker gradient background
      gradient.addColorStop(0, 'rgba(6, 182, 212, 0.3)'); // Cyan with transparency
      gradient.addColorStop(1, 'rgba(9, 11, 19, 0.1)'); // Very dark with low transparency
    } else {
      // Light mode: lighter gradient background
      gradient.addColorStop(0, 'rgba(8, 145, 178, 0.2)'); // Lighter cyan with transparency
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0.1)'); // Light with transparency
    }
    chart.current = new DrawChart(ref.current!, {
      type: 'line',
      options: {
        maintainAspectRatio: false,
        responsive: true,
        layout: {
          padding: {
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            display: false,
            grid: {
              color: mode === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
            },
          },
          x: {
            display: false,
            grid: {
              color: mode === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
            },
          },
        },
        plugins: {
          legend: {
            display: false,
          },
        },
      },
      data: {
        labels: list.map((row) => newDayjs(row.date).format('DD/MM/YYYY')),
        datasets: [
          {
            borderColor: lineColor,
            borderWidth: 2,
            pointBackgroundColor: pointColor,
            pointBorderColor: pointColor,
            pointHoverBackgroundColor: lineColor,
            pointHoverBorderColor: lineColor,
            pointRadius: 4,
            pointHoverRadius: 6,
            // @ts-ignore
            label: list?.[0]?.totalForks ? 'Forks by date' : 'Stars by date',
            backgroundColor: gradient,
            fill: true,
            // @ts-ignore
            data: list.map((row) => row.totalForks || row.totalStars),
          },
        ],
      },
    });
    return () => {
      chart?.current?.destroy();
    };
  }, [mode, list]);
  return <canvas className="w-full h-full" ref={ref} />;
};
