export function fetchUser(id: number): { id: number; name: string; source: string } {
  return { id, name: `real-${id}`, source: "network" };
}

export const API_URL = "https://real.example";
