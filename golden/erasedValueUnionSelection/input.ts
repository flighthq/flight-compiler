interface Payload {
  id: string;
}

// A cache or registry stores what it was handed: the value is erased, so each alternative of the union asks
// the runtime for the kind it needs and extracts it through the runtime's own accessor. Both doors into
// that conversion -- the contextual position and the assertion -- are the same checked selection.
export function entry(payload: unknown): number | string | undefined {
  return payload as number | string | undefined;
}

export function objectEntry(payload: unknown): Payload | number {
  return payload as Payload | number;
}

export function contextual(payload: any): number | string {
  return payload;
}

export function accept(_payload: number | string): number {
  return 1;
}

export function pass(payload: unknown): number {
  return accept(payload as number | string);
}
