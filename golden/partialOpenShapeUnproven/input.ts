interface Info {
  readonly value: number;
}

// An open string index has no fixed member set, so there is no object shape to make optional.
export function lookup(values: Partial<Record<string, Info>>, key: string): Info | undefined {
  return values[key];
}
