/**
 * Generates a synthetic-but-realistic project (shared module graph + preact
 * components) and benchmarks rasch against vitest (stock and tuned) on it.
 *
 *   node scripts/bench.mjs [files-count] [tests-per-file]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const APP = join(ROOT, "app");
const FILE_COUNT = Number(process.argv[2] ?? 40);
const TESTS_PER_FILE = Number(process.argv[3] ?? 25);
const LIB_COUNT = 30;
const RUNS = 3;

// --- generate the app -------------------------------------------------------
rmSync(APP, { recursive: true, force: true });
mkdirSync(join(APP, "lib"), { recursive: true });
mkdirSync(join(APP, "tests"), { recursive: true });

for (let i = 0; i < LIB_COUNT; i++) {
  const next = (i + 1) % LIB_COUNT;
  writeFileSync(
    join(APP, "lib", `util-${i}.ts`),
    `${i === LIB_COUNT - 1 ? "" : `import { transform${next} } from "./util-${next}";\n`}
export function transform${i}(value: number): number {
  const base = (value * ${i + 3}) % 1013;
  ${i === LIB_COUNT - 1 ? "return base;" : `return transform${next}(base) + ${i};`}
}
export function label${i}(name: string): string {
  return \`[\${name}:${i}]\`;
}
export const TABLE_${i} = Array.from({ length: 50 }, (_, k) => k * ${i + 1});
`,
  );
}

for (let i = 0; i < 10; i++) {
  writeFileSync(
    join(APP, "lib", `Card-${i}.tsx`),
    `import { label${i} } from "./util-${i}";

export function Card${i}({ title, items }: { title: string; items: string[] }) {
  return (
    <section class="card">
      <h2>{label${i}(title)}</h2>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
`,
  );
}

for (let i = 0; i < FILE_COUNT; i++) {
  const lib = i % LIB_COUNT;
  const isDom = i % 4 === 3; // every 4th file renders components
  const header = isDom
    ? `// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render } from "preact";
import { Card${lib % 10} } from "../lib/Card-${lib % 10}";
import { transform${lib}, TABLE_${lib} } from "../lib/util-${lib}";`
    : `import { describe, it, expect } from "vitest";
import { transform${lib}, label${lib}, TABLE_${lib} } from "../lib/util-${lib}";`;

  const tests = [];
  for (let t = 0; t < TESTS_PER_FILE; t++) {
    if (isDom && t % 5 === 0) {
      tests.push(`  it("renders card ${t}", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(<Card${lib % 10} title="t${t}" items={["a${t}", "b${t}"]} />, host);
    expect(host.querySelectorAll("li").length).toBe(2);
    expect(host.querySelector("h2")!.textContent).toContain("t${t}");
    host.remove();
  });`);
    } else {
      tests.push(`  it("computes case ${t}", () => {
    const result = transform${lib}(${t});
    expect(result).toBe(transform${lib}(${t}));
    expect(TABLE_${lib}[${t % 50}]).toBe(${(t % 50) * (lib + 1)});
    expect([...TABLE_${lib}].sort((a, b) => a - b)).toEqual(TABLE_${lib});
  });`);
    }
  }
  writeFileSync(
    join(APP, "tests", `suite-${String(i).padStart(3, "0")}.test.${isDom ? "tsx" : "ts"}`),
    `${header}

describe("suite ${i}", () => {
${tests.join("\n\n")}
});
`,
  );
}

writeFileSync(
  join(APP, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        jsxImportSource: "preact",
        strict: true,
        noEmit: true,
      },
      include: ["lib", "tests"],
    },
    null,
    2,
  ),
);
writeFileSync(
  join(APP, "vitest.config.ts"),
  `import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.?(c|m)[jt]s?(x)"] } });
`,
);
writeFileSync(
  join(APP, "vitest.tuned.config.ts"),
  `import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.?(c|m)[jt]s?(x)"],
    pool: "threads",
    isolate: false,
  },
});
`,
);
writeFileSync(
  join(APP, "vitest.bundled.config.ts"),
  `import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.?(c|m)[jt]s?(x)"],
    experimental: { bundledExecution: true },
  },
});
`,
);

console.log(`generated: ${FILE_COUNT} test files x ${TESTS_PER_FILE} tests, ${LIB_COUNT} shared lib modules`);
