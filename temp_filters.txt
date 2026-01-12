'use client';
// Cache bust: 2026-01-11

import { useCalendar } from '@gitroom/frontend/components/launches/calendar.context';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { useCallback, useState } from 'react';
import { SelectCustomer } from '@gitroom/frontend/components/launches/select.customer';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import i18next from 'i18next';
import { newDayjs } from '@gitroom/frontend/components/layout/set.timezone';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';

// Helper function to get start and end dates based on display type
function getDateRange(
  display: 'day' | 'week' | 'month',
  referenceDate?: string
) {
  const date = referenceDate ? newDayjs(referenceDate) : newDayjs();

  switch (display) {
    case 'day':
      return {
        startDate: date.format('YYYY-MM-DD'),
        endDate: date.format('YYYY-MM-DD'),
      };
    case 'week':
      return {
        startDate: date.startOf('isoWeek').format('YYYY-MM-DD'),
        endDate: date.endOf('isoWeek').format('YYYY-MM-DD'),
      };
    case 'month':
      return {
        startDate: date.startOf('month').format('YYYY-MM-DD'),
        endDate: date.endOf('month').format('YYYY-MM-DD'),
      };
  }
}

export const Filters = () => {
  const calendar = useCalendar();
  const t = useT();
  const fetch = useFetch();
  const toast = useToaster();
  const [isValidating, setIsValidating] = useState(false);

  // Set dayjs locale based on current language
  const currentLanguage = i18next.resolvedLanguage || 'en';
  dayjs.locale();

  // Calculate display date range text
  const getDisplayText = () => {
    const startDate = newDayjs(calendar.startDate);
    const endDate = newDayjs(calendar.endDate);

    switch (calendar.display) {
      case 'day':
        return startDate.format('dddd (L)');
      case 'week':
        return `${startDate.format('L')} - ${endDate.format('L')}`;
      case 'month':
        return startDate.format('MMMM YYYY');
      default:
        return '';
    }
  };

  const setToday = useCallback(() => {
    const today = newDayjs();
    const currentRange = getDateRange(
      calendar.display as 'day' | 'week' | 'month'
    );

    // Check if we're already showing today's range
    if (
      calendar.startDate === currentRange.startDate &&
      calendar.endDate === currentRange.endDate
    ) {
      return; // No need to set the same range
    }

    calendar.setFilters({
      startDate: currentRange.startDate,
      endDate: currentRange.endDate,
      display: calendar.display as 'day' | 'week' | 'month',
      customer: calendar.customer,
    });
  }, [calendar]);

  const setDay = useCallback(() => {
    // If already in day view and showing today, don't change
    if (calendar.display === 'day') {
      const todayRange = getDateRange('day');
      if (calendar.startDate === todayRange.startDate) {
        return;
      }
    }

    const range = getDateRange('day');
    calendar.setFilters({
      startDate: range.startDate,
      endDate: range.endDate,
      display: 'day',
      customer: calendar.customer,
    });
  }, [calendar]);

  const setWeek = useCallback(() => {
    // If already in week view and showing current week, don't change
    if (calendar.display === 'week') {
      const currentWeekRange = getDateRange('week');
      if (calendar.startDate === currentWeekRange.startDate) {
        return;
      }
    }

    const range = getDateRange('week');
    calendar.setFilters({
      startDate: range.startDate,
      endDate: range.endDate,
      display: 'week',
      customer: calendar.customer,
    });
  }, [calendar]);

  const setMonth = useCallback(() => {
    // If already in month view and showing current month, don't change
    if (calendar.display === 'month') {
      const currentMonthRange = getDateRange('month');
      if (calendar.startDate === currentMonthRange.startDate) {
        return;
      }
    }

    const range = getDateRange('month');
    calendar.setFilters({
      startDate: range.startDate,
      endDate: range.endDate,
      display: 'month',
      customer: calendar.customer,
    });
  }, [calendar]);

  const setCustomer = useCallback(
    (customer: string) => {
      if (calendar.customer === customer) {
        return; // No need to set the same customer
      }
      calendar.setFilters({
        startDate: calendar.startDate,
        endDate: calendar.endDate,
        display: calendar.display as 'day' | 'week' | 'month',
        customer: customer,
      });
    },
    [calendar]
  );

  const next = useCallback(() => {
    const currentStart = newDayjs(calendar.startDate);
    let nextStart: dayjs.Dayjs;

    switch (calendar.display) {
      case 'day':
        nextStart = currentStart.add(1, 'day');
        break;
      case 'week':
        nextStart = currentStart.add(1, 'week');
        break;
      case 'month':
        nextStart = currentStart.add(1, 'month');
        break;
      default:
        nextStart = currentStart.add(1, 'week');
    }

    const range = getDateRange(
      calendar.display as 'day' | 'week' | 'month',
      nextStart.format('YYYY-MM-DD')
    );
    calendar.setFilters({
      startDate: range.startDate,
      endDate: range.endDate,
      display: calendar.display as 'day' | 'week' | 'month',
      customer: calendar.customer,
    });
  }, [calendar]);

  const previous = useCallback(() => {
    const currentStart = newDayjs(calendar.startDate);
    let prevStart: dayjs.Dayjs;

    switch (calendar.display) {
      case 'day':
        prevStart = currentStart.subtract(1, 'day');
        break;
      case 'week':
        prevStart = currentStart.subtract(1, 'week');
        break;
      case 'month':
        prevStart = currentStart.subtract(1, 'month');
        break;
      default:
        prevStart = currentStart.subtract(1, 'week');
    }

    const range = getDateRange(
      calendar.display as 'day' | 'week' | 'month',
      prevStart.format('YYYY-MM-DD')
    );
    calendar.setFilters({
      startDate: range.startDate,
      endDate: range.endDate,
      display: calendar.display as 'day' | 'week' | 'month',
      customer: calendar.customer,
    });
  }, [calendar]);

  const setCurrent = useCallback(
    (type: 'day' | 'week' | 'month') => () => {
      if (type === 'day') {
        setDay();
      } else if (type === 'week') {
        setWeek();
      } else if (type === 'month') {
        setMonth();
      }
    },
    []
  );

  const validateAllTimeSlots = useCallback(async () => {
    if (isValidating) return;
    
    setIsValidating(true);
    toast.show('Validating all scheduled posts...', 'info');
    
    try {
      const response = await fetch('/integrations/validate-all-timeslots', {
        method: 'POST',
      });

      if (!response.ok) {
        toast.show('Failed to validate time slots', 'warning');
        setIsValidating(false);
        return;
      }

      const result = await response.json();

      if (result.rescheduled > 0) {
        toast.show(
          `✓ Rescheduled ${result.rescheduled} of ${result.checked} posts to valid time slots`,
          'success'
        );
        // Refresh calendar to show updated posts
        calendar.reloadCalendarView();
      } else {
        toast.show('✓ All posts are already at valid time slots', 'success');
      }
    } catch (error) {
      toast.show('Failed to validate time slots', 'warning');
    } finally {
      setIsValidating(false);
    }
  }, [fetch, toast, calendar, isValidating]);

  return (
    <div className="text-textColor flex flex-col md:flex-row gap-[8px] items-center select-none">
      <div className="flex flex-grow flex-row items-center gap-[10px]">
        <div className="border h-[42px] border-newTableBorder bg-newTableBorder gap-[1px] flex items-center rounded-[8px] overflow-hidden">
          <div
            onClick={previous}
            className="cursor-pointer text-textColor rtl:rotate-180 px-[9px] bg-newBgColorInner h-full flex items-center justify-center hover:text-textItemFocused hover:bg-boxFocused"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="8"
              height="12"
              viewBox="0 0 8 12"
              fill="none"
            >
              <path gap-[8px]">
            <div
              onClick={setToday}
              className="hover:text-textItemFocused hover:bg-boxFocused py-[3px] px-[9px] flex justify-center items-center rounded-[8px] transition-all cursor-pointer text-[14px] bg-newBgColorInner border border-newTableBorder"
            >
              Today
            </div>
            <div
              onClick={validateAllTimeSlots}
              className={clsx(
                'hover:text-textItemFocused hover:bg-boxFocused py-[3px] px-[9px] flex justify-center items-center gap-[6px] rounded-[8px] transition-all text-[14px] bg-newBgColorInner border border-newTableBorder',
                isValidating ? 'cursor-wait opacity-60' : 'cursor-pointer'
              )}
              title={t('validate_all_time_slots_tooltip', 'Reschedule any posts that are not at configured time slots')}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 32 32"
                fill="none"
                className={isValidating ? 'animate-spin' : ''}
              >
                <path
                  d="M16 2C8.28 2 2 8.28 2 16C2 23.72 8.28 30 16 30C23.72 30 30 23.72 30 16C30 8.28 23.72 2 16 2ZM16 28C9.38 28 4 22.62 4 16C4 9.38 9.38 4 16 4C22.62 4 28 9.38 28 16C28 22.62 22.62 28 16 28ZM22.3 10.3L14 18.6L9.7 14.3C9.3 13.9 8.7 13.9 8.3 14.3C7.9 14.7 7.9 15.3 8.3 15.7L13.3 20.7C13.5 20.9 13.7 21 14 21C14.3 21 14.5 20.9 14.7 20.7L23.7 11.7C24.1 11.3 24.1 10.7 23.7 10.3C23.3 9.9 22.7 9.9 22.3 10.3Z"
                  fill="currentColor"
                />
              </svg>
              <span>{t('validate_time_slots', 'Validate Time Slots')}</span>okeLinejoin="round"
              />
            </svg>
          </div>
          <div className="w-[200px] text-center bg-newBgColorInner h-full flex items-center justify-center">
            <div className="py-[3px] px-[9px] rounded-[5px] transition-all text-[14px]">
              {getDisplayText()}
            </div>
          </div>
          <div
            onClick={next}
            className="cursor-pointer text-textColor rtl:rotate-180 px-[9px] bg-newBgColorInner h-full flex items-center justify-center hover:text-textItemFocused hover:bg-boxFocused"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="8"
              height="12"
              viewBox="0 0 8 12"
              fill="none"
            >
              <path
                d="M1.5 11L6.5 6L1.5 1"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
        <div className="flex-1 text-[14px] font-[500]">
          <div className="text-center flex h-[42px]">
            <div
              onClick={setToday}
              className="hover:text-textItemFocused hover:bg-boxFocused py-[3px] px-[9px] flex justify-center items-center rounded-[8px] transition-all cursor-pointer text-[14px] bg-newBgColorInner border border-newTableBorder"
            >
              Today
            </div>
          </div>
        </div>
      </div>
      <SelectCustomer
        customer={calendar.customer as string}
        onChange={(customer: string) => setCustomer(customer)}
        integrations={calendar.integrations}
      />
      <div className="flex flex-row p-[4px] border border-newTableBorder rounded-[8px] text-[14px] font-[500]">
        <div
          className={clsx(
            'pt-[6px] pb-[5px] cursor-pointer w-[74px] text-center rounded-[6px]',
            calendar.display === 'day' && 'text-textItemFocused bg-boxFocused'
          )}
          onClick={setDay}
        >
          {t('day', 'Day')}
        </div>
        <div
          className={clsx(
            'pt-[6px] pb-[5px] cursor-pointer w-[74px] text-center rounded-[6px]',
            calendar.display === 'week' && 'text-textItemFocused bg-boxFocused'
          )}
          onClick={setWeek}
        >
          {t('week', 'Week')}
        </div>
        <div
          className={clsx(
            'pt-[6px] pb-[5px] cursor-pointer w-[74px] text-center rounded-[6px]',
            calendar.display === 'month' && 'text-textItemFocused bg-boxFocused'
          )}
          onClick={setMonth}
        >
          {t('month', 'Month')}
        </div>
      </div>
    </div>
  );
};
};
