export interface Item {
  readonly name: string;
  readonly count: number;
}

export function busiestCount(items: readonly Item[]): number {
  let best: Item | undefined = undefined;
  for (const item of items) {
    if (best === undefined || item.count > best.count) {
      best = item;
    }
  }
  return best === undefined ? 0 : best.count;
}
