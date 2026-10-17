export function mutate(values: number[]): void {
  values.reverse();
}

export function owned(): number[] {
  const values = [1, 2, 3];
  return values.reverse();
}

export function aliased(): number {
  const values = [1, 2, 3];
  const returned = values.reverse();
  returned.push(4);
  return values.length;
}
