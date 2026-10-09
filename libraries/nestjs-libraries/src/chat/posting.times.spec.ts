import {
  labelsToPostingTimes,
  minutesToLabel,
  parsePostingTimes,
  toPostingTimeView,
} from './posting.times';

describe('minutesToLabel', () => {
  it('formats minutes since midnight as HH:mm', () => {
    expect(minutesToLabel(0)).toBe('00:00');
    expect(minutesToLabel(560)).toBe('09:20');
    expect(minutesToLabel(1439)).toBe('23:59');
  });

  it('wraps out-of-range values into a single day', () => {
    expect(minutesToLabel(1440)).toBe('00:00');
    expect(minutesToLabel(-60)).toBe('23:00');
  });
});

describe('parsePostingTimes', () => {
  it('parses the JSON string column into a sorted list', () => {
    expect(parsePostingTimes('[{"time":850},{"time":560}]')).toEqual([
      { time: 560 },
      { time: 850 },
    ]);
  });

  it('returns [] for null, empty, malformed or non-array input', () => {
    expect(parsePostingTimes(null)).toEqual([]);
    expect(parsePostingTimes(undefined)).toEqual([]);
    expect(parsePostingTimes('')).toEqual([]);
    expect(parsePostingTimes('not json')).toEqual([]);
    expect(parsePostingTimes('{"time":1}')).toEqual([]);
  });

  it('drops entries without a numeric time', () => {
    expect(parsePostingTimes('[{"time":"x"},{"nope":1},{"time":60}]')).toEqual([
      { time: 60 },
    ]);
  });
});

describe('toPostingTimeView', () => {
  it('adds an HH:mm label to each slot', () => {
    expect(toPostingTimeView('[{"time":560}]')).toEqual([
      { time: 560, label: '09:20' },
    ]);
  });
});

describe('labelsToPostingTimes', () => {
  it('converts HH:mm labels to sorted, de-duplicated slots', () => {
    expect(labelsToPostingTimes(['14:10', '09:20', '9:20'])).toEqual({
      times: [{ time: 560 }, { time: 850 }],
    });
  });

  it('accepts an empty list (clears all slots)', () => {
    expect(labelsToPostingTimes([])).toEqual({ times: [] });
  });

  it('reports every invalid label instead of silently dropping it', () => {
    expect(labelsToPostingTimes(['09:20', '24:00', '9:7', 'noon'])).toEqual({
      invalid: ['24:00', '9:7', 'noon'],
    });
  });
});
