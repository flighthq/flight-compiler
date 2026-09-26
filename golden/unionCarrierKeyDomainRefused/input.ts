interface Counts {
  [index: number]: number;
}

interface Fields {
  [name: string]: string;
}

// The alternatives must agree on the key's domain, because one key expression reaches every carrier: a
// string key cannot be the lookup of a carrier keyed by number. The read is refused and named rather than
// projected with a key the other carrier does not have.
export function read(value: Counts | Fields, key: string): number | string | undefined {
  return value[key];
}
