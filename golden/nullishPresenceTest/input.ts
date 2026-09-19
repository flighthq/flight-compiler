export function comparesEqualsString(value: string): boolean {
  return value === undefined;
}

export function comparesIndexed(values: Readonly<Record<string, string>>, key: string): boolean {
  return values[key] !== undefined;
}

export function comparesNumber(flag: number): boolean {
  return flag !== undefined;
}

export function comparesNullable(value: string | null): boolean {
  return value != undefined;
}

export function comparesString(value: string): boolean {
  return value !== undefined;
}

export function comparesStringLoose(value: string): boolean {
  return value != null;
}
