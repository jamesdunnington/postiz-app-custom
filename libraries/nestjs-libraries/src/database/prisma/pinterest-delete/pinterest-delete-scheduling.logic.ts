// Chains `count` new deletion slots off `startingPointer` (the last slot
// already promised to this integration's queue), each one random(minMinutes,
// maxMinutes) after the previous — inclusive on both ends, freshly rolled
// per item, so consecutive real-world gaps look human rather than uniform.
// If the pointer is null or already in the past, the chain starts from `now`
// instead, so a caught-up queue doesn't inherit a stale future/past anchor.
//
// batchSize (default 1, preserving prior one-pin-per-slot behavior) groups
// every `batchSize` consecutive items onto the same slot, so a slot means
// "delete this many pins together" rather than always exactly one.
export function computeChainedSlots(
  startingPointer: Date | null,
  count: number,
  minMinutes: number,
  maxMinutes: number,
  now: Date = new Date(),
  randomFn: () => number = Math.random,
  batchSize = 1
): Date[] {
  let cursor =
    startingPointer && startingPointer.getTime() > now.getTime()
      ? startingPointer.getTime()
      : now.getTime();

  const spanMinutes = maxMinutes - minMinutes + 1;
  const safeBatchSize = Math.max(1, batchSize);
  const slots: Date[] = [];
  for (let i = 0; i < count; i++) {
    if (i % safeBatchSize === 0) {
      const minutes = minMinutes + Math.floor(randomFn() * spanMinutes);
      cursor += minutes * 60_000;
    }
    slots.push(new Date(cursor));
  }
  return slots;
}
