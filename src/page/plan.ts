export interface PartPlan {
  /** 1-based part number, as R2 multipart numbers them. */
  n: number;
  start: number;
  /** exclusive */
  end: number;
}

/**
 * Slice `size` bytes into `partSize` chunks: every part is exactly `partSize` except the
 * last, which carries the remainder (R2 requires equal non-last parts).
 */
export function planParts(size: number, partSize: number): PartPlan[] {
  if (!Number.isInteger(partSize) || partSize <= 0) {
    throw new Error(`partSize must be a positive integer, got ${partSize}`);
  }
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`size must be a positive integer, got ${size}`);
  }
  const plan: PartPlan[] = [];
  for (let start = 0, n = 1; start < size; start += partSize, n++) {
    plan.push({ n, start, end: Math.min(start + partSize, size) });
  }
  return plan;
}
