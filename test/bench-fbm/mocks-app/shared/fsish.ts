export function read(key: string): string {
  return `real:${key}`;
}

const api = { read };
export default api;
