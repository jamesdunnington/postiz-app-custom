'use client';

import { Select } from '@gitroom/react/form/select';
import React, { useState, useEffect } from 'react';
import { isUSCitizen } from '@gitroom/frontend/components/launches/helpers/isuscitizen.utils';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
dayjs.extend(timezone);
dayjs.extend(utc);

const dateMetrics = [
  { label: 'AM:PM', value: 'US' },
  { label: '24 hours', value: 'GLOBAL' },
];

// Generate GMT offset options from -12 to +14 (30-min increments)
const generateGMTOptions = () => {
  const options = [];
  for (let hours = -12; hours <= 14; hours++) {
    for (let minutes = 0; minutes < 60; minutes += 30) {
      if (hours === 14 && minutes > 0) break; // GMT+14 is max
      
      const totalMinutes = hours * 60 + (hours < 0 ? -minutes : minutes);
      const sign = totalMinutes >= 0 ? '+' : '';
      const displayHours = Math.floor(Math.abs(totalMinutes) / 60);
      const displayMinutes = Math.abs(totalMinutes) % 60;
      const label = `GMT${sign}${hours}${displayMinutes > 0 ? `:${displayMinutes.toString().padStart(2, '0')}` : ''}`;
      
      options.push({ label, value: totalMinutes });
    }
  }
  return options;
};

const gmtOptions = generateGMTOptions();

const MetricComponent = () => {
  const fetch = useFetch();
  const toast = useToaster();
  const [currentMetric, setCurrentMetric] = useState(isUSCitizen());
  const [currentTimezone, setCurrentTimezone] = useState<number>(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Get current offset from dayjs
    const detectedOffset = dayjs.tz().utcOffset();
    setCurrentTimezone(detectedOffset);
  }, []);

  const changeMetric = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setCurrentMetric(value === 'US');
    localStorage.setItem('isUS', value);
  };

  const changeTimezone = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = parseInt(event.target.value);
    setLoading(true);
    
    try {
      await fetch('/user/timezone', {
        method: 'PUT',
        body: JSON.stringify({ timezone: value }),
      });
      
      setCurrentTimezone(value);
      toast.show('Timezone updated successfully', 'success');
    } catch (error) {
      console.error('Failed to update timezone:', error);
      toast.show('Failed to update timezone', 'warning');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="my-[16px] mt-[16px] bg-sixth border-fifth border rounded-[4px] p-[24px] flex flex-col gap-[24px]">
      <div className="mt-[4px]">Date Metrics</div>
      <Select name="metric" disableForm={true} label="" onChange={changeMetric}>
        {dateMetrics.map((metric) => (
          <option
            key={metric.value}
            value={metric.value}
            selected={currentMetric === (metric.value === 'US')}
          >
            {metric.label}
          </option>
        ))}
      </Select>

      <div className="mt-[4px]">Timezone</div>
      <Select
        name="timezone"
        disableForm={true}
        label=""
        onChange={changeTimezone}
        disabled={loading}
      >
        {gmtOptions.map((option) => (
          <option
            key={option.value}
            value={option.value}
            selected={option.value === currentTimezone}
          >
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
};

export default MetricComponent;
