import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../..");
export interface Requirement {
  id: string;
  area: string;
  requirement: string;
}

export async function requirements(): Promise<Requirement[]> {
  const source = await readFile(
    join(root, "rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md"),
    "utf8",
  );
  const result: Requirement[] = [];
  let area = "";
  for (const line of source.split("\n")) {
    if (line.startsWith("## ")) area = line.slice(3);
    const match = /^- \[[ xX]\] `([A-Z0-9]+-\d{2})` (.+)$/.exec(line);
    if (match) result.push({ id: match[1]!, area, requirement: match[2]! });
  }
  const ids = new Set(result.map(({ id }) => id));
  if (
    result.length !== 40 ||
    ids.size !== 40 ||
    result.some(({ id }) => !/^V1-(?:0[1-9]|[1-3]\d|40)$/.test(id))
  )
    throw new Error("Expected the current 40 unique V1 checklist IDs.");
  return result;
}

async function testFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      [
        "node_modules",
        "dist",
        "build",
        "test-results",
        ".next",
        ".turbo",
      ].includes(entry.name)
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await testFiles(path)));
    else if (
      entry.isFile() &&
      /(?:\.(?:test|spec)\.(?:ts|tsx)|\/integration\.ts)$/.test(path)
    )
      result.push(path);
  }
  return result;
}

/** Source pointers describe possible partial coverage; every checklist item stays pending. */
export async function evidencePlan() {
  const items = (await requirements()).map((item) => ({
    ...item,
    status: "pending" as const,
    testSources: [] as { path: string; line: number; title: string }[],
  }));
  for (const directory of ["apps", "packages", "tools"])
    for (const path of await testFiles(join(root, directory))) {
      const source = ts.createSourceFile(
        path,
        await readFile(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const inspect = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const first = node.arguments[0];
          let title = "",
            ids: string[] = [];
          if (
            /\btest$/.test(node.expression.getText(source)) &&
            first &&
            ts.isStringLiteralLike(first)
          ) {
            title = first.text;
            ids = [...title.matchAll(/V1-\d{2}/g)].map((match) => match[0]);
          } else if (
            node.expression.getText(source) === "verificationCase" &&
            first &&
            ts.isObjectLiteralExpression(first)
          )
            for (const property of first.properties) {
              if (!ts.isPropertyAssignment(property)) continue;
              if (
                property.name.getText(source) === "id" &&
                ts.isStringLiteralLike(property.initializer)
              )
                title = property.initializer.text;
              if (
                property.name.getText(source) === "gates" &&
                ts.isArrayLiteralExpression(property.initializer)
              )
                ids = property.initializer.elements.flatMap((element) =>
                  ts.isStringLiteralLike(element) ? [element.text] : [],
                );
            }
          for (const id of new Set(ids)) {
            const item = items.find((candidate) => candidate.id === id);
            if (!item)
              throw new Error(`Unknown current checklist ID ${id} in ${path}`);
            item.testSources.push({
              path: path.slice(root.length + 1),
              line:
                source.getLineAndCharacterOfPosition(node.getStart(source))
                  .line + 1,
              title,
            });
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }
  return {
    kind: "v1-evidence-plan",
    requiredChecks: items.length,
    acceptance: false,
    note: "Test source pointers are partial coverage plans. Actual results and review of every named behavior are still required.",
    checks: items,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const destination = resolve(
    process.argv[2] ?? join(root, "verification", `v1-plan-${Date.now()}`),
  );
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const path = join(destination, "evidence-plan.json");
  await writeFile(path, JSON.stringify(await evidencePlan(), null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(
    JSON.stringify({ report: path, acceptance: false }) + "\n",
  );
}
