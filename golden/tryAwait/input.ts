export async function attempt(task: Promise<number>, fallback: number): Promise<number> {
  let result: number = 0;
  try {
    result = await task;
  } catch {
    result = fallback;
  }
  return result;
}
