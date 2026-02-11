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
    const textColor = mode === 'dark' ? '#fff' : '#000';
    
    const gradient = ref.current
      .getContext('2d')
      .createLinearGradient(0, 0, 0, ref.current.height);
    gradient.addColorStop(0, 'rgba(114, 118, 137, 1)'); // Start color with some transparency
    gradient.addColorStop(1, 'rgb(9, 11, 19, 1)');
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
            borderColor: textColor,
            pointBackgroundColor: textColor,
            pointBorderColor: textColor,
            pointHoverBackgroundColor: textColor,
            pointHoverBorderColor: textColor,
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
