export const log: string[] = [];
log.push("eval");

export function taint(): void {
  log.push("taint");
}
