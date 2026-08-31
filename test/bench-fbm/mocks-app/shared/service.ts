import { fetchUser } from "./api";

export function getUserName(id: number): string {
  return fetchUser(id).name;
}
