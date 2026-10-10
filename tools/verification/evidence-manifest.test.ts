import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  auditEvidenceManifest,
  type EvidenceAuditContext,
} from "./evidence-manifest.js";
import { requirements } from "./gate-audit.js";
import { gateReviewOracles } from "./gate-review-oracles.js";

async function fixture() {
  const checklist = await requirements();
  assert.equal(checklist.length, 40);
  assert.deepEqual(
    checklist.map(({ id, requirement }) => [id, requirement]),
    [...gateReviewOracles],
  );
  const directory = await mkdtemp(join(tmpdir(), "rootset-report-audit-"));
  const path = join(directory, "artifact.txt");
  const bytes = Buffer.from(
    "Validator fixture; this is not a product result.\n",
  );
  await writeFile(path, bytes);
  const manifest = {
    candidateVersion: "validator-fixture-v1",
    checks: Object.fromEntries(
      checklist.map(({ id, requirement }) => [
        id,
        {
          requirement,
          status: "passed",
          method: "Validator fixture",
          environment: "In-memory metadata fixture",
          result: "Synthetic validator input",
          recordedAt: "2026-10-05T00:00:00.000Z",
          limitations: [] as string[],
          artifacts: [
            { path, sha256: createHash("sha256").update(bytes).digest("hex") },
          ],
        },
      ]),
    ),
  };
  const context: EvidenceAuditContext = {
    candidateVersion: manifest.candidateVersion,
    requirements: checklist,
    readArtifact: readFile,
  };
  return {
    manifest,
    context,
    path,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("V1 report validation never turns complete metadata into product acceptance", async () => {
  const value = await fixture();
  try {
    const result = await auditEvidenceManifest(value.manifest, value.context);
    assert.equal(result.validRecords, 40);
    assert.equal(result.reportedPassed, 40);
    assert.equal(result.reportComplete, true);
    assert.equal(result.acceptanceReady, false);
    assert.deepEqual(result.failures, []);
  } finally {
    await value.cleanup();
  }
});

test("historical gate manifests, missing or duplicate current requirements and candidate mismatch are refused", async () => {
  const value = await fixture();
  try {
    for (const manifest of [
      null,
      [],
      { candidateCommit: "a".repeat(40), gates: {} },
      { ...value.manifest, candidateVersion: "historical" },
    ]) {
      const result = await auditEvidenceManifest(manifest, value.context);
      assert.equal(result.reportComplete, false);
      assert.equal(result.acceptanceReady, false);
    }
    for (const checklist of [
      value.context.requirements.slice(1),
      [...value.context.requirements.slice(1), value.context.requirements[1]!],
    ]) {
      const result = await auditEvidenceManifest(value.manifest, {
        ...value.context,
        requirements: checklist,
      });
      assert.equal(result.reportComplete, false);
      assert.match(result.failures.join("\n"), /40 unique/);
    }
  } finally {
    await value.cleanup();
  }
});

test("executed result records require method, environment, current clauses, UTC date and artifact bytes", async () => {
  const value = await fixture();
  try {
    const original = value.manifest.checks["V1-01"]!;
    for (const change of [
      { requirement: "Reduced clause" },
      { method: "" },
      { environment: "" },
      { result: "" },
      { recordedAt: "2026-02-30T00:00:00.000Z" },
      { limitations: undefined },
      { artifacts: [] },
      { status: "invented-pass" },
    ]) {
      const result = await auditEvidenceManifest(
        {
          ...value.manifest,
          checks: {
            ...value.manifest.checks,
            "V1-01": { ...original, ...change },
          },
        },
        value.context,
      );
      assert.equal(result.validRecords, 39);
      assert.equal(result.reportComplete, false);
    }
    await writeFile(value.path, "Changed artifact\n");
    const changed = await auditEvidenceManifest(value.manifest, value.context);
    assert.equal(changed.validRecords, 0);
    assert.equal(changed.failures.length, 40);
    await rm(value.path);
    const missing = await auditEvidenceManifest(value.manifest, value.context);
    assert.equal(missing.validRecords, 0);
    assert.ok(
      missing.failures.every((failure) =>
        failure.includes("artifact unavailable"),
      ),
    );
  } finally {
    await value.cleanup();
  }
});

test("pending and failed results keep their truthful status and remaining limitations", async () => {
  const value = await fixture();
  try {
    const record = value.manifest.checks["V1-01"]!;
    for (const [status, artifacts] of [
      ["pending", []],
      ["failed", record.artifacts],
    ] as const) {
      const result = await auditEvidenceManifest(
        {
          ...value.manifest,
          checks: {
            ...value.manifest.checks,
            "V1-01": {
              ...record,
              status,
              artifacts,
              limitations: ["Fresh native run remains pending"],
            },
          },
        },
        value.context,
      );
      assert.equal(result.reportComplete, true);
      assert.equal(result.reportedPassed, 39);
      assert.equal(result.acceptanceReady, false);
    }
    const unknown = await auditEvidenceManifest(
      {
        ...value.manifest,
        checks: { ...value.manifest.checks, "DEV-01": record },
      },
      value.context,
    );
    assert.equal(unknown.reportComplete, false);
    assert.match(unknown.failures.join("\n"), /not in the current checklist/);
  } finally {
    await value.cleanup();
  }
});
