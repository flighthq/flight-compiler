interface Alpha {
  value: number;
}

interface Beta {
  other: number;
}

function pick(): Alpha | Beta | undefined {
  return undefined;
}

const target = new Set<Alpha | Beta>();
const lookup = new Map<string, Alpha | Beta>();

// The present value is `Alpha | Beta` and the collection holds `Alpha | Beta`, so the call passes the one
// variant the element is; only the absence the lookup admitted is projected away.
export function add(): void {
  const found = pick();
  if (found === undefined) return;
  target.add(found);
}

export function put(key: string): void {
  const value = pick();
  if (value === undefined) return;
  lookup.set(key, value);
}
