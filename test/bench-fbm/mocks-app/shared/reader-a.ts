import { BASE } from "./base-dep";
export const A_BASE = BASE;
export function makeUrl(p: string): string {
  return `${A_BASE}${p}`;
}
