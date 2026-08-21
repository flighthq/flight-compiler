type Shape = {
  other: boolean;
  value: number;
};

export function project({ value }: Shape, source: Shape): number {
  let assigned = 0;
  ({ value: assigned } = source);
  return value + assigned;
}
