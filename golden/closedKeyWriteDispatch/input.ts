interface Pairs {
  alpha?: number;
  beta?: number;
}

// The key's value chooses the member, so the write is a dispatch: each branch assigns the member its key
// names, and the assignment lands on the object rather than on a temporary.
export function set(pairs: Pairs, key: 'alpha' | 'beta', value: number): void {
  pairs[key] = value;
}
