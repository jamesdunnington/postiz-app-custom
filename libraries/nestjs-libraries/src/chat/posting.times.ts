// Integration.postingTimes is a JSON-encoded *string* column
// (e.g. '[{"time":560},{"time":850}]'), where each `time` is minutes since the
// user's local midnight. Always go through these helpers rather than touching
// the raw column.

export type PostingTime = { time: number };

const DAY_MINUTES = 24 * 60;
const LABEL_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export const minutesToLabel = (minutes: number): string => {
  const wrapped = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
};

export const parsePostingTimes = (
  raw: string | null | undefined
): PostingTime[] => {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((p) => p && typeof p.time === 'number' && Number.isFinite(p.time))
      .map((p) => ({ time: p.time as number }))
      .sort((a, b) => a.time - b.time);
  } catch (err) {
    return [];
  }
};

export const toPostingTimeView = (raw: string | null | undefined) =>
  parsePostingTimes(raw).map(({ time }) => ({
    time,
    label: minutesToLabel(time),
  }));

export const labelsToPostingTimes = (
  labels: string[]
): { times: PostingTime[] } | { invalid: string[] } => {
  const invalid: string[] = [];
  const minutes = new Set<number>();

  for (const label of labels) {
    const match = LABEL_PATTERN.exec(label.trim());
    if (!match) {
      invalid.push(label);
      continue;
    }
    minutes.add(Number(match[1]) * 60 + Number(match[2]));
  }

  if (invalid.length) {
    return { invalid };
  }

  return {
    times: [...minutes].sort((a, b) => a - b).map((time) => ({ time })),
  };
};
