// Matches a bare Pinterest pin id (all-digit string) or a Pinterest pin URL
// like https://www.pinterest.com/pin/123456789012345678/?utm=abc
export function parsePinInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const urlMatch = trimmed.match(/pinterest\.[a-z.]+\/pin\/(\d+)/i);
  if (urlMatch) {
    return urlMatch[1];
  }

  return null;
}

// Given an integration's batch ids ordered newest-first, returns the ids
// beyond the retention limit that should be purged.
export function pickBatchIdsToPurge(
  batchIdsNewestFirst: string[],
  keep = 2
): string[] {
  return batchIdsNewestFirst.slice(keep);
}
