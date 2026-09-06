import { parsePinInput, pickBatchIdsToPurge } from './pinterest-delete.logic';

describe('parsePinInput', () => {
  it('accepts a bare numeric pin id', () => {
    expect(parsePinInput('123456789012345678')).toBe('123456789012345678');
  });

  it('extracts the id from a full pin URL', () => {
    expect(
      parsePinInput('https://www.pinterest.com/pin/123456789012345678/')
    ).toBe('123456789012345678');
  });

  it('extracts the id from a pin URL with query params and no trailing slash', () => {
    expect(
      parsePinInput(
        'https://www.pinterest.com/pin/123456789012345678?utm=abc'
      )
    ).toBe('123456789012345678');
  });

  it('returns null for an unrecognized string', () => {
    expect(parsePinInput('not-a-pin')).toBeNull();
  });

  it('returns null for an empty or whitespace-only string', () => {
    expect(parsePinInput('   ')).toBeNull();
  });
});

describe('pickBatchIdsToPurge', () => {
  it('purges nothing when at or under the retention limit', () => {
    expect(pickBatchIdsToPurge(['b2', 'b1'], 2)).toEqual([]);
    expect(pickBatchIdsToPurge(['b1'], 2)).toEqual([]);
    expect(pickBatchIdsToPurge([], 2)).toEqual([]);
  });

  it('purges everything beyond the 2 most recent batches', () => {
    expect(pickBatchIdsToPurge(['b3', 'b2', 'b1'], 2)).toEqual(['b1']);
  });

  it('purges multiple batches when far beyond the limit', () => {
    expect(pickBatchIdsToPurge(['b5', 'b4', 'b3', 'b2', 'b1'], 2)).toEqual([
      'b3',
      'b2',
      'b1',
    ]);
  });
});
