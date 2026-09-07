export function hasFlag(flags: number, flag: number): boolean {
  return (flags & flag) !== 0;
}

export function setFlag(flags: number, flag: number): number {
  return flags | flag;
}

export function clearFlag(flags: number, flag: number): number {
  return flags & ~flag;
}

export function toggleFlag(flags: number, flag: number): number {
  return flags ^ flag;
}

export function countFlags(flags: number): number {
  let count: number = 0;
  let remaining: number = flags;
  while (remaining > 0) {
    if ((remaining & 1) !== 0) {
      count += 1;
    }
    remaining = remaining >> 1;
  }
  return count;
}
