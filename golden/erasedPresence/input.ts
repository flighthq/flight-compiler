export function absentLoose(value: any): boolean {
  return value == null;
}

export function absentStrict(value: any): boolean {
  return value === undefined;
}

export function immutableAuto(grid: ReadonlyArray<number>): boolean {
  const rows = grid.length;
  return rows !== undefined;
}

export function mutablePresent(flag: boolean): boolean {
  let value: any = 3;
  if (flag) value = undefined;
  return value !== undefined;
}

export function notNull(value: any): boolean {
  return value !== null;
}

export function presentLoose(value: any): boolean {
  return value != null;
}

export function presentStrict(value: any): boolean {
  return value !== undefined;
}
