import { computeChainedSlots } from './pinterest-move-scheduling.logic';

describe('computeChainedSlots', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('chains off `now` when there is no starting pointer', () => {
    const slots = computeChainedSlots(null, 1, 50, 60, now, () => 0);
    expect(slots[0].toISOString()).toBe('2026-01-01T00:50:00.000Z');
  });

  it('chains off `now` when the starting pointer is in the past', () => {
    const pastPointer = new Date('2025-12-31T00:00:00.000Z');
    const slots = computeChainedSlots(pastPointer, 1, 50, 60, now, () => 0);
    expect(slots[0].toISOString()).toBe('2026-01-01T00:50:00.000Z');
  });

  it('chains off the starting pointer when it is in the future', () => {
    const futurePointer = new Date('2026-01-01T02:00:00.000Z');
    const slots = computeChainedSlots(futurePointer, 1, 50, 60, now, () => 0);
    expect(slots[0].toISOString()).toBe('2026-01-01T02:50:00.000Z');
  });

  it('uses the minimum minutes when randomFn returns 0', () => {
    const slots = computeChainedSlots(null, 1, 50, 60, now, () => 0);
    expect(slots[0].getTime() - now.getTime()).toBe(50 * 60_000);
  });

  it('uses the maximum minutes when randomFn returns just under 1', () => {
    const slots = computeChainedSlots(null, 1, 50, 60, now, () => 0.999999);
    expect(slots[0].getTime() - now.getTime()).toBe(60 * 60_000);
  });

  it('produces strictly increasing timestamps, each within [min,max] minutes of the previous one', () => {
    const values = [0, 0.5, 0.99];
    let callIndex = 0;
    const slots = computeChainedSlots(null, 3, 50, 60, now, () => values[callIndex++]);

    expect(slots).toHaveLength(3);
    let previous = now.getTime();
    for (const slot of slots) {
      const diffMinutes = (slot.getTime() - previous) / 60_000;
      expect(diffMinutes).toBeGreaterThanOrEqual(50);
      expect(diffMinutes).toBeLessThanOrEqual(60);
      previous = slot.getTime();
    }
  });

  it('defaults to Math.random and Date.now when not supplied (smoke test only)', () => {
    const slots = computeChainedSlots(null, 1, 50, 60);
    expect(slots).toHaveLength(1);
    expect(slots[0].getTime()).toBeGreaterThan(Date.now());
  });

  it('groups batchSize consecutive items onto the same slot', () => {
    const slots = computeChainedSlots(null, 5, 50, 60, now, () => 0, 2);

    expect(slots[0].getTime()).toBe(slots[1].getTime());
    expect(slots[2].getTime()).toBe(slots[3].getTime());
    expect(slots[4].getTime()).toBeGreaterThan(slots[3].getTime());
    expect(slots[0].getTime() - now.getTime()).toBe(50 * 60_000);
    expect(slots[2].getTime() - now.getTime()).toBe(100 * 60_000);
  });

  it('treats batchSize < 1 as 1 (never groups zero or negative items)', () => {
    const oneAtATime = computeChainedSlots(null, 3, 50, 60, now, () => 0);
    const zeroBatchSize = computeChainedSlots(null, 3, 50, 60, now, () => 0, 0);

    expect(zeroBatchSize.map((s) => s.getTime())).toEqual(
      oneAtATime.map((s) => s.getTime())
    );
  });
});
