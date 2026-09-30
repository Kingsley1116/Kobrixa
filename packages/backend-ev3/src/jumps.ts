import { lc, relativeOffset } from "./encoding.js";

export type Label = string | symbol;

export interface JumpPatch {
  at: number;
  after: number;
  target: Label;
}

/** Resolve symbolic jumps after emission, optionally relaxing their DATA32 operands. */
export function patchJumps(
  bytes: readonly number[],
  labels: ReadonlyMap<Label, number>,
  patches: readonly JumpPatch[],
  compact: boolean,
  signal: AbortSignal,
): Uint8Array {
  // Patches are recorded in emission order. Each starts as a five-byte LC4.
  let widths = patches.map(() => 5);
  let removed: number[] = [];
  const rebuildOffsets = (): void => {
    removed = [0];
    for (const width of widths) removed.push(removed.at(-1)! + 5 - width);
  };
  const position = (original: number): number => {
    let low = 0;
    let high = patches.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (patches[middle]!.after <= original) low = middle + 1;
      else high = middle;
    }
    return original - removed[low]!;
  };
  rebuildOffsets();
  if (compact) {
    let changed: boolean;
    do {
      signal.throwIfAborted();
      changed = false;
      const nextWidths = patches.map((patch, index) => {
        const target = labels.get(patch.target)!;
        const offset = position(target) - position(patch.after);
        const current = widths[index]!;
        for (const width of [1, 2, 3]) {
          if (width >= current) break;
          // Shortening a backwards jump also moves its own end toward the
          // target. Forward targets and the jump end move by the same amount.
          const candidate = offset + (target < patch.after ? current - width : 0);
          if (lc(candidate).length <= width) {
            changed = true;
            return width;
          }
        }
        return current;
      });
      widths = nextWidths;
      rebuildOffsets();
      // Widths only shrink; later passes discover jumps made shorter by peers.
    } while (changed);
  }

  const output: number[] = [];
  let cursor = 0;
  for (const patch of patches) {
    for (; cursor < patch.at; cursor += 1) output.push(bytes[cursor]!);
    const offset = position(labels.get(patch.target)!) - position(patch.after);
    output.push(...(compact ? lc(offset) : relativeOffset(offset)));
    cursor = patch.after;
  }
  for (; cursor < bytes.length; cursor += 1) output.push(bytes[cursor]!);
  return Uint8Array.from(output);
}
