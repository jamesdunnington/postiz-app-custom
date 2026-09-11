export interface BatchScheduleRow {
  content: string;
  title?: string;
  imageUrl: string;
  boardId: string;
  altText?: string;
  link?: string;
  scheduledDate?: string;
}

export interface AssignedRow extends BatchScheduleRow {
  assignedPublishDate: Date;
}

export interface RowError {
  row: BatchScheduleRow;
  error: string;
}

// Resolves every row's final publish date in one pass, synchronously, at
// submit time — never recomputed later. Explicit scheduled_date rows keep
// their exact time; blank rows are auto-assigned via fetchAutoSlots (backed
// by PostsRepository.getNextAvailableSlots in the service), requesting a
// small buffer so an accidental collision with an explicit date from the
// same batch can be dropped before assigning the rest, in original CSV
// row order among themselves.
export async function assignPublishDates(
  rows: BatchScheduleRow[],
  now: Date,
  fetchAutoSlots: (count: number) => Promise<Date[]>
): Promise<{ assigned: AssignedRow[]; errors: RowError[] }> {
  const errors: RowError[] = [];
  const explicitRows: { row: BatchScheduleRow; date: Date; originalIndex: number }[] = [];
  const autoRows: { row: BatchScheduleRow; originalIndex: number }[] = [];

  rows.forEach((row, originalIndex) => {
    if (!row.content || !row.content.trim()) {
      errors.push({ row, error: 'Missing content' });
      return;
    }
    if (!row.imageUrl || !row.imageUrl.trim()) {
      errors.push({ row, error: 'Missing image_url' });
      return;
    }
    if (!row.boardId || !row.boardId.trim()) {
      errors.push({ row, error: 'Missing board' });
      return;
    }

    if (row.scheduledDate && row.scheduledDate.trim()) {
      const parsed = new Date(row.scheduledDate);
      if (isNaN(parsed.getTime())) {
        errors.push({
          row,
          error: `Unparseable scheduled_date: ${row.scheduledDate}`,
        });
        return;
      }
      if (parsed.getTime() <= now.getTime()) {
        errors.push({ row, error: 'scheduled_date is in the past' });
        return;
      }
      explicitRows.push({ row, date: parsed, originalIndex });
    } else {
      autoRows.push({ row, originalIndex });
    }
  });

  let autoSlots: Date[] = [];
  if (autoRows.length > 0) {
    const candidateSlots = await fetchAutoSlots(
      autoRows.length + explicitRows.length
    );
    const explicitTimestamps = new Set(
      explicitRows.map((r) => r.date.getTime())
    );
    autoSlots = candidateSlots
      .filter((s) => !explicitTimestamps.has(s.getTime()))
      .slice(0, autoRows.length);
  }

  const assignedWithIndex = [
    ...explicitRows.map(({ row, date, originalIndex }) => ({
      ...row,
      assignedPublishDate: date,
      originalIndex,
    })),
    ...autoRows.map(({ row, originalIndex }, i) => ({
      ...row,
      assignedPublishDate: autoSlots[i],
      originalIndex,
    })),
  ];

  assignedWithIndex.sort((a, b) => a.originalIndex - b.originalIndex);

  const assigned: AssignedRow[] = assignedWithIndex.map(
    ({ originalIndex, ...rest }) => rest
  );

  return { assigned, errors };
}
