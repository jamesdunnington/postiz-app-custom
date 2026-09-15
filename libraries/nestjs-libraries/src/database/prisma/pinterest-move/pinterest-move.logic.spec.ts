import { parsePinInput } from './pinterest-move.logic';

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
