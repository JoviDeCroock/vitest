import { readBase } from "./base-dep";
export function describeBase(): string {
  return `base:${readBase()}`;
}
