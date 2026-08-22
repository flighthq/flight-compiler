export async function attempt(task: Promise<number>, backup: Promise<number>): Promise<number> {
  let result: number = 0;
  try {
    result = await task;
  } catch {
    result = await backup;
  }
  return result;
}
