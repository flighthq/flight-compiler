export async function attempt(task: Promise<number>, log: number[]): Promise<number> {
  let result: number = 0;
  try {
    result = await task;
  } catch {
    result = 1;
  } finally {
    log.push(result);
  }
  return result;
}
