interface Texture {
  size: number;
  name: string;
}

function read(): Texture | undefined {
  return undefined;
}

// `typeof value !== 'undefined'` is a presence test the source states, and the union stores one optional:
// the member the test names IS the absence marker, so the answer is the storage's own presence. Nothing is
// cast, copied, or visited -- and the narrowing the guard states is what lets the read below reach the
// member rather than the optional that holds it.
export function sizeWhenPresent(): number {
  const texture = read();
  if (typeof texture !== 'undefined') return texture.size;
  return 0;
}

// The same test with the opposite polarity: the branch that names the sentinel is the branch that does not
// hold a value.
export function sizeWhenAbsent(): number {
  const texture = read();
  if (typeof texture === 'undefined') return 0;
  return texture.size;
}
