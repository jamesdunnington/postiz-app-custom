import { assignPublishDates, BatchScheduleRow } from './batch-schedule.logic';

const now = new Date('2026-01-01T00:00:00.000Z');

const validRow = (overrides: Partial<BatchScheduleRow> = {}): BatchScheduleRow => ({
  content: 'Some pin content',
  imageUrl: 'https://example.com/image.jpg',
  boardId: 'board-1',
  ...overrides,
});

describe('assignPublishDates', () => {
  it('rejects a row with missing content', async () => {
    const { assigned, errors } = await assignPublishDates(
      [validRow({ content: '' })],
      now,
      async () => []
    );
    expect(assigned).toHaveLength(0);
    expect(errors).toEqual([
      { row: expect.objectContaining({ content: '' }), error: 'Missing content' },
    ]);
  });

  it('rejects a row with missing image_url', async () => {
    const { errors } = await assignPublishDates(
      [validRow({ imageUrl: '' })],
      now,
      async () => []
    );
    expect(errors[0].error).toBe('Missing image_url');
  });

  it('rejects a row with missing board', async () => {
    const { errors } = await assignPublishDates(
      [validRow({ boardId: '' })],
      now,
      async () => []
    );
    expect(errors[0].error).toBe('Missing board');
  });

  it('rejects an unparseable scheduled_date', async () => {
    const { errors } = await assignPublishDates(
      [validRow({ scheduledDate: 'not-a-date' })],
      now,
      async () => []
    );
    expect(errors[0].error).toBe('Unparseable scheduled_date: not-a-date');
  });

  it('rejects a scheduled_date in the past', async () => {
    const { errors } = await assignPublishDates(
      [validRow({ scheduledDate: '2025-01-01T00:00:00.000Z' })],
      now,
      async () => []
    );
    expect(errors[0].error).toBe('scheduled_date is in the past');
  });

  it('uses an explicit future scheduled_date as-is', async () => {
    const { assigned, errors } = await assignPublishDates(
      [validRow({ scheduledDate: '2026-02-01T12:00:00.000Z' })],
      now,
      async () => []
    );
    expect(errors).toHaveLength(0);
    expect(assigned[0].assignedPublishDate.toISOString()).toBe(
      '2026-02-01T12:00:00.000Z'
    );
  });

  it('auto-assigns blank rows to fetched slots, in original CSV order', async () => {
    const slots = [
      new Date('2026-01-02T12:00:00.000Z'),
      new Date('2026-01-03T12:00:00.000Z'),
    ];
    const fetchAutoSlots = jest.fn().mockResolvedValue(slots);

    const { assigned, errors } = await assignPublishDates(
      [validRow({ content: 'first' }), validRow({ content: 'second' })],
      now,
      fetchAutoSlots
    );

    expect(errors).toHaveLength(0);
    expect(fetchAutoSlots).toHaveBeenCalledWith(2);
    expect(assigned[0].content).toBe('first');
    expect(assigned[0].assignedPublishDate).toEqual(slots[0]);
    expect(assigned[1].content).toBe('second');
    expect(assigned[1].assignedPublishDate).toEqual(slots[1]);
  });

  it('requests a buffer of extra auto slots and drops any that collide with an explicit date in the same batch', async () => {
    const collidingSlot = new Date('2026-02-01T12:00:00.000Z'); // same instant as the explicit row below
    const okSlot = new Date('2026-02-02T12:00:00.000Z');
    const fetchAutoSlots = jest.fn().mockResolvedValue([collidingSlot, okSlot]);

    const rows = [
      validRow({ content: 'explicit', scheduledDate: '2026-02-01T12:00:00.000Z' }),
      validRow({ content: 'auto' }),
    ];

    const { assigned, errors } = await assignPublishDates(rows, now, fetchAutoSlots);

    expect(errors).toHaveLength(0);
    expect(fetchAutoSlots).toHaveBeenCalledWith(2); // 1 auto row + 1 explicit row buffer
    const autoAssigned = assigned.find((a) => a.content === 'auto');
    expect(autoAssigned?.assignedPublishDate).toEqual(okSlot);
  });

  it('preserves original CSV row order in the output even when explicit and auto rows are interleaved', async () => {
    const fetchAutoSlots = jest.fn().mockResolvedValue([
      new Date('2026-01-05T00:00:00.000Z'),
    ]);
    const rows = [
      validRow({ content: 'auto-first' }),
      validRow({ content: 'explicit-second', scheduledDate: '2026-01-10T00:00:00.000Z' }),
    ];

    const { assigned } = await assignPublishDates(rows, now, fetchAutoSlots);

    expect(assigned.map((a) => a.content)).toEqual(['auto-first', 'explicit-second']);
  });

  it('does not call fetchAutoSlots when every row has an explicit date', async () => {
    const fetchAutoSlots = jest.fn().mockResolvedValue([]);
    await assignPublishDates(
      [validRow({ scheduledDate: '2026-02-01T00:00:00.000Z' })],
      now,
      fetchAutoSlots
    );
    expect(fetchAutoSlots).not.toHaveBeenCalled();
  });
});
