import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { format } from "prettier";
import { root } from "./environment.js";

export interface Requirement {
  id: string;
  area: string;
  requirement: string;
  caseIds: string[];
  testSources: { path: string; line: number; title: string }[];
  observations: {
    caseId: string;
    status: string;
    scope: string;
    artifact: string;
    sourceCommit: string;
    coherentCandidate: boolean;
  }[];
  requiredEvidence: string[];
  status: "pending";
}

const browserGates = new Set([
  "AUTH-01",
  "AUTH-05",
  "AUTH-06",
  "AUTH-11",
  "FLD-09",
  "FLD-10",
  "FLD-15",
  "ROW-06",
  "ACC-12",
  "KEY-07",
  "PERF-05",
  "REL-02",
]);
const scaleGates = new Set([
  "ROW-04",
  "ROW-05",
  "AUD-10",
  "QRY-10",
  "QRY-11",
  "PERF-01",
  "PERF-02",
  "PERF-03",
  "PERF-04",
  "PERF-05",
  "PERF-06",
  "PERF-07",
  "PERF-08",
]);
const recoveryGates = new Set([
  "ACC-10",
  "AUTH-10",
  "AUTH-13",
  "DB-06",
  "DB-09",
  "DB-11",
  "DB-12",
  "ROW-10",
  "UNI-07",
  "AUD-08",
  "AUD-09",
  "IO-04",
  "IO-05",
  "IO-09",
  "BKP-06",
  "BKP-07",
  "BKP-09",
  "BKP-10",
  "BKP-11",
  "BKP-12",
  "BKP-13",
  "JOB-01",
  "JOB-02",
  "JOB-03",
  "JOB-05",
  "JOB-06",
  "PERF-08",
  "OPS-03",
  "OPS-04",
  "OPS-06",
  "OPS-07",
  "OPS-08",
]);
const roleMatrix = new Set([
  "ACC-02",
  "ACC-03",
  "ACC-04",
  "ACC-07",
  "ACC-11",
  "KEY-02",
  "KEY-03",
  "KEY-04",
  "KEY-08",
  "AUD-06",
  "API-05",
  "API-06",
  "API-12",
  "MCP-05",
  "MCP-07",
  "MCP-11",
  "MCP-12",
  "JOB-04",
  "IO-08",
]);

export async function requirements(): Promise<Requirement[]> {
  const source = await readFile(
    join(root, "rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md"),
    "utf8",
  );
  const result: Requirement[] = [];
  let area = "";
  for (const line of source.split("\n")) {
    if (line.startsWith("## ")) area = line.slice(3);
    const match = /^- \[[ xX]\] `([A-Z]+-\d{2})` (.+)$/.exec(line);
    if (!match) continue;
    const id = match[1]!;
    const requiredEvidence = [
      "Exact source/image/contract/migration digests, UTC result and named reviewer; test names alone do not establish completion.",
    ];
    if (/^(FLD|ROW|UNI|AUD|DB|QRY|IO|BKP|JOB)-/.test(id))
      requiredEvidence.push(
        "Actual PostgreSQL with non-owner API/DDL/identity roles and authoritative storage readback.",
      );
    if (browserGates.has(id) || id.startsWith("UI-"))
      requiredEvidence.push(
        "Actual rendered routes, desktop/mobile light/dark, Safari and Chromium, traces/screenshots and keyboard/accessibility observations.",
      );
    if (scaleGates.has(id))
      requiredEvidence.push(
        "Declared hardware/RTT, five million live rows, 24 typed fields, wide fixture, ten million history events, recorded distributions/checksums, cold/warm percentiles and errors.",
      );
    if (recoveryGates.has(id))
      requiredEvidence.push(
        "Failure injected at relevant durable boundary; resumed process, terminal state and source/artifact/counter/history comparison.",
      );
    if (roleMatrix.has(id))
      requiredEvidence.push(
        "Allowed/denied role x session/personal key/team key/OAuth x organisation/database/table matrix, plus next-request revocation/demotion.",
      );
    if (id.startsWith("MCP-"))
      requiredEvidence.push(
        "Pinned real MCP client and OAuth transport execution; protocol mock does not prove compatibility.",
      );
    if (id.startsWith("BKP-") || id.startsWith("IO-"))
      requiredEvidence.push(
        "Actual isolated S3-compatible artifact upload/download, checksums, permission failure and expiry; backups require isolated restore comparison.",
      );
    if (/^AUTH-(12|13)$/.test(id))
      requiredEvidence.push(
        "Actual isolated SMTP, recipient/plain-text/rendered email, outbox retries and delivered message deduplication.",
      );
    if (id.startsWith("OPS-") || /^DEV-0[158]$/.test(id))
      requiredEvidence.push(
        "Fresh supported environment/non-root images and documented commands; representative populated upgrade/restore where applicable.",
      );
    if (id.startsWith("REL-"))
      requiredEvidence.push(
        "Complete candidate audit and explicit implementation/verification reviewer approvals; no inferred human sign-off.",
      );
    result.push({
      id,
      area,
      requirement: match[2]!,
      caseIds: [],
      testSources: [],
      observations: [],
      requiredEvidence,
      status: "pending",
    });
  }
  if (
    result.length !== 205 ||
    new Set(result.map((item) => item.id)).size !== 205
  )
    throw new Error(
      "The 205-gate acceptance contract changed or has duplicate IDs. Review scope before regenerating evidence plans.",
    );
  return result;
}

interface ResultArtifact {
  kind: string;
  coherentCandidate: boolean;
  sourceCommit: string;
  cases: { id: string; gates: string[]; status: string; scope: string }[];
}

// Source references describe intended partial coverage, never an observed result.
async function sourceReferences(items: Requirement[]): Promise<void> {
  const suitePointers = [
    {
      path: "tools/verification/scale-fixture.ts",
      gates: ["PERF-01"],
      title:
        "Actual five-million-row/24-field/ten-million-event and 200-field byte-limit fixture with distributions, bounded checksums and measured hardware; owner seeding is performance setup only.",
    },
    {
      path: "tools/verification/scale-benchmark.ts",
      gates: [
        "ROW-04",
        "ROW-05",
        "QRY-05",
        "QRY-06",
        "AUD-10",
        "PERF-02",
        "PERF-03",
        "PERF-04",
        "PERF-07",
      ],
      title:
        "Scenario pointers: capacity, indexed200, result5000, result25000, history200, edit10, navigation, timeout and scans. Review each recorded scenario result; cold/profile/network/browser evidence remains separate.",
    },
    {
      path: "tools/verification/scale-http-profile.ts",
      gates: [
        "QRY-05",
        "QRY-06",
        "QRY-10",
        "AUD-10",
        "PERF-02",
        "PERF-03",
        "PERF-04",
        "PERF-07",
        "PERF-06",
        "PERF-08",
        "BKP-05",
        "BKP-10",
        "OPS-06",
      ],
      title:
        "Actual capped-runtime HTTP workload source:1000-request qualified cold/warm200/5000/byte-capped25000/history scenarios,990matching+10whole-scan per unindexed type with foreground probes,ten concurrent clients and authoritative versions/history; actual background/fullscale jobs, resource samples and capped service/socket recovery. Source pointer is not an executed result or full profile approval.",
    },
    {
      path: "apps/rootset-api/src/runtime.test.ts",
      gates: [
        "API-03",
        "API-04",
        "API-05",
        "API-06",
        "API-09",
        "API-11",
        "API-12",
        "MCP-01",
        "MCP-05",
        "MCP-07",
        "MCP-08",
        "MCP-09",
        "MCP-10",
        "MCP-11",
        "MCP-12",
        "ACC-07",
        "KEY-07",
      ],
      title:
        "Actual runtime workflow: partial transport, row/key/history, browser approval and revocation evidence; review the individual assertions.",
    },
    {
      path: "apps/rootset-api/src/http.test.ts",
      gates: [
        "API-07",
        "API-05",
        "API-06",
        "MCP-01",
        "MCP-02",
        "MCP-07",
        "MCP-08",
        "MCP-09",
        "MCP-13",
      ],
      title:
        "Suite pointer: strict decoding plus real SDK/native OAuth transport; domain permission fixture is isolated and actual runtime evidence remains separate.",
    },
    {
      path: "apps/rootset-api/src/admission.test.ts",
      gates: ["API-08"],
      title:
        "Real PostgreSQL admission concurrency, rate counts and expired lease recovery.",
    },
    {
      path: "packages/oauth/src/oauth.test.ts",
      gates: ["MCP-02", "MCP-03", "MCP-05", "MCP-06", "MCP-07"],
      title:
        "Suite pointer: real persisted authorization/PKCE binding, refresh-family concurrency, consent targets, audience, expiry and revocation.",
    },
    {
      path: "packages/oauth/src/metadata.test.ts",
      gates: ["MCP-04"],
      title:
        "Suite pointer: six adversarial metadata fetch-policy cases with controlled network I/O; positive external DNS/TLS deployment remains separate.",
    },
  ];
  for (const pointer of suitePointers) {
    await readFile(join(root, pointer.path), "utf8");
    for (const id of pointer.gates) {
      const gate = items.find((item) => item.id === id);
      if (!gate) throw new Error(`Unknown curated gate ${id}`);
      gate.testSources.push({
        path: pointer.path,
        line: 1,
        title: pointer.title,
      });
    }
  }
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter((path) =>
      /(?:\.(?:test|spec)\.(?:ts|tsx)|\/integration\.ts)$/.test(path),
    );
  const gatesIn = (value: string): string[] => {
    const result = [];
    const areas = new Set(items.map((item) => item.id.split("-")[0]));
    for (const match of value.matchAll(/([A-Z]+)-(\d{2}(?:\/\d{2})*)/g)) {
      // Review finding IDs such as OC-03 are not acceptance gate IDs.
      if (!areas.has(match[1]!)) continue;
      for (const number of match[2]!.split("/"))
        result.push(`${match[1]}-${number}`);
    }
    return result;
  };
  for (const path of files) {
    const source = ts.createSourceFile(
      path,
      await readFile(join(root, path), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(source);
        let title: string | undefined;
        let gates: string[] = [];
        const first = node.arguments[0];
        if (
          /\btest$/.test(expression) &&
          first &&
          ts.isStringLiteralLike(first)
        ) {
          title = first.text;
          gates = gatesIn(title);
        } else if (
          expression === "verificationCase" &&
          first &&
          ts.isObjectLiteralExpression(first)
        ) {
          for (const property of first.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const name = property.name.getText(source);
            if (name === "id" && ts.isStringLiteralLike(property.initializer))
              title = property.initializer.text;
            if (
              name === "gates" &&
              ts.isArrayLiteralExpression(property.initializer)
            )
              gates = property.initializer.elements.flatMap((element) =>
                ts.isStringLiteralLike(element) ? gatesIn(element.text) : [],
              );
          }
        }
        if (title)
          for (const id of new Set(gates)) {
            const gate = items.find((item) => item.id === id);
            if (!gate)
              throw new Error(`Unknown checklist gate ${id} in test ${path}`);
            const line =
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1;
            gate.testSources.push({ path, line, title });
          }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
}

async function run(): Promise<void> {
  const items = await requirements();
  await sourceReferences(items);
  const directory = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const observed: { artifact: ResultArtifact; path: string }[] = [];
  if (directory)
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".json")) continue;
      const artifact = JSON.parse(
        await readFile(join(directory, file), "utf8"),
      ) as ResultArtifact;
      if (artifact.kind === "test-results" && Array.isArray(artifact.cases))
        observed.push({ artifact, path: join(directory, file) });
    }
  const caseIds = new Set<string>();
  for (const { artifact, path } of observed)
    for (const testcase of artifact.cases) {
      caseIds.add(testcase.id);
      for (const id of testcase.gates) {
        const gate = items.find((item) => item.id === id);
        if (!gate)
          throw new Error(`Unknown checklist gate ${id} in ${testcase.id}`);
        if (!gate.caseIds.includes(testcase.id)) gate.caseIds.push(testcase.id);
        gate.observations.push({
          caseId: testcase.id,
          status: testcase.status,
          scope: testcase.scope,
          artifact: path,
          sourceCommit: artifact.sourceCommit,
          coherentCandidate: artifact.coherentCandidate,
        });
      }
    }
  const report = {
    requiredGates: items.length,
    signedOff: 0,
    observedTestCases: caseIds.size,
    gatesWithoutNamedTestSource: items
      .filter((item) => item.testSources.length === 0)
      .map((item) => item.id),
    note: "Observed tests provide partial evidence. Every gate remains pending until its complete requirement and required evidence are reviewed against the exact candidate.",
    artifacts: observed.map(({ artifact, path }) => ({
      path,
      sourceCommit: artifact.sourceCommit,
      coherentCandidate: artifact.coherentCandidate,
    })),
    gates: items,
  };
  const destination = directory ?? join(root, "docs/verification");
  await mkdir(destination, { recursive: true });
  await writeFile(
    join(
      destination,
      directory ? "gate-audit.json" : "gate-evidence-plan.json",
    ),
    await format(JSON.stringify(report), { parser: "json" }),
  );
  process.stdout.write(
    JSON.stringify({
      requiredGates: items.length,
      signedOff: 0,
      observedTestCases: caseIds.size,
      report: join(
        destination,
        directory ? "gate-audit.json" : "gate-evidence-plan.json",
      ),
    }) + "\n",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
)
  await run();
