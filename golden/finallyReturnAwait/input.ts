export async function attempt(task: Promise<number>, log: number[]): Promise<number> {
  try {
    return await task;
  } finally {
    log.push(1);
  }
}
