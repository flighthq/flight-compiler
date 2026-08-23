export interface Box<Value> {
  readonly contents: Value;
}

export function unwrap<Value>(box: Box<Value>): Value {
  return box.contents;
}

export function firstOf<Value>(values: readonly Value[], fallback: Value): Value {
  const first = values[0];
  return first ?? fallback;
}

export function secondName(pair: readonly [string, string]): string {
  const second = pair[1];
  return second;
}
