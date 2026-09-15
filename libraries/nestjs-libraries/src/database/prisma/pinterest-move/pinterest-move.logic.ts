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
