import { useState } from "preact/hooks";

export function Counter({ initial = 0 }: { initial?: number }) {
  const [count, setCount] = useState(initial);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      count: {count}
    </button>
  );
}
