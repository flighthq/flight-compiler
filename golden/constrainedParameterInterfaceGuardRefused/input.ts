// The same constrained parameter with an interface constraint rather than a string: the guard is what
// refuses, because the parameter has no storage for the sentinel its constraint carries. The read behind it
// would sit on a type argument a sentinel-bearing instantiation does not have, so no rewriting of the test
// can make it sound; the refusal names the declaration to change.
interface RichTextContent {
  readonly plain?: string;
}

export function plainLength<T extends RichTextContent | undefined>(content: T): number {
  if (content === undefined) return 0;
  return content.plain ? content.plain.length : 0;
}
