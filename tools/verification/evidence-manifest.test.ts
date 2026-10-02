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
import { gateReviewOracles } from "./gate-review-oracles.js";

const checklist = await readFile(
  new URL(
    "../../rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md",
    import.meta.url,
  ),
  "utf8",
);
const requirements = [
  ...checklist.matchAll(/^- \[[ xX]\] `([A-Z]+-\d{2})` (.+)$/gm),
].map((match) => ({
  id: match[1]!,
  requirement: match[2]!,
  positiveReviewOracle: gateReviewOracles.get(match[1]!)!,
}));
assert.equal(requirements.length, 205);
assert.ok(
  requirements.every(({ positiveReviewOracle }) => positiveReviewOracle),
);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "rootset-evidence-audit-"));
  const path = join(directory, "artifact.txt");
  const bytes = Buffer.from(
    "Audit metadata fixture only; no product verification.\n",
  );
  await writeFile(path, bytes);
  const candidateCommit = "a".repeat(40);
  const imageDigests = Object.fromEntries(
    ["postgres", "api", "worker", "web"].map((service, index) => [
      service,
      `sha256:${String(index + 1).repeat(64)}`,
    ]),
  );
  const manifest = {
    candidateCommit,
    imageDigests,
    gates: Object.fromEntries(
      requirements.map((requirement) => [
        requirement.id,
        {
          status: "passed",
          candidateCommit,
          requirement: requirement.requirement,
          positiveReviewOracle: requirement.positiveReviewOracle,
          wholeRequirementReviewed: true,
          coveredClauses: [requirement.positiveReviewOracle],
          remainingClauses: [] as string[],
          reviewer: "Validator fixture reviewer",
          reviewerUTC: "2026-10-02T00:00:00.000Z",
          testCases: ["VALIDATOR-FIXTURE-ONLY"],
          artifacts: [
            { path, sha256: createHash("sha256").update(bytes).digest("hex") },
          ],
        },
      ]),
    ),
  };
  const context: EvidenceAuditContext = {
    candidateCommit,
    sourceClean: true,
    requirements,
    readArtifact: readFile,
    inspectImage: async (digest) => ({
      available: Object.values(imageDigests).includes(digest),
      sourceCommit: candidateCommit,
    }),
  };
  return {
    manifest,
    context,
    artifactPath: path,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("EVIDENCE-AUDIT-01: structurally complete metadata has no validation failures", async () => {
  const value = await fixture();
  try {
    const result = await auditEvidenceManifest(value.manifest, value.context);
    assert.equal(result.requiredGates, 205);
    assert.equal(result.verified, 205);
    assert.equal(result.acceptanceReady, true);
    assert.deepEqual(result.failures, []);
  } finally {
    await value.cleanup();
  }
});

test("EVIDENCE-AUDIT-02: passed statuses cannot conceal incomplete whole clauses", async () => {
  const value = await fixture();
  try {
    for (const gate of Object.values(value.manifest.gates)) {
      gate.wholeRequirementReviewed = false;
      gate.remainingClauses.push("Unreviewed literal condition");
    }
    const result = await auditEvidenceManifest(value.manifest, value.context);
    assert.equal(result.verified, 0);
    assert.equal(result.acceptanceReady, false);
    assert.equal(
      result.failures.filter((failure) => failure.includes("whole requirement"))
        .length,
      205,
    );
    assert.equal(
      result.failures.filter((failure) => failure.includes("remaining clauses"))
        .length,
      205,
    );
  } finally {
    await value.cleanup();
  }
});

test("EVIDENCE-AUDIT-03: source mismatch or dirty candidate makes global verified zero", async () => {
  const value = await fixture();
  try {
    for (const change of [
      { candidateCommit: "b".repeat(40) },
      { sourceClean: false },
    ]) {
      const result = await auditEvidenceManifest(value.manifest, {
        ...value.context,
        ...change,
      });
      assert.equal(result.locallyValidGateEvidence, 205);
      assert.equal(result.verified, 0);
      assert.equal(result.acceptanceReady, false);
      assert.match(result.failures.join("\n"), /Candidate source/);
    }
  } finally {
    await value.cleanup();
  }
});

test("EVIDENCE-AUDIT-04: all four immutable images must be valid and inspected", async () => {
  const value = await fixture();
  try {
    const mutations = [
      { ...value.manifest.imageDigests, worker: undefined },
      { ...value.manifest.imageDigests, api: "rootset:latest" },
      {},
    ];
    for (const imageDigests of mutations) {
      const result = await auditEvidenceManifest(
        { ...value.manifest, imageDigests },
        value.context,
      );
      assert.equal(result.verified, 0);
      assert.equal(result.acceptanceReady, false);
    }
    for (const inspectImage of [
      async () => ({ available: false }),
      async () => {
        throw new Error("Docker unavailable");
      },
    ]) {
      const result = await auditEvidenceManifest(value.manifest, {
        ...value.context,
        inspectImage,
      });
      assert.equal(result.locallyValidGateEvidence, 205);
      assert.equal(result.verified, 0);
      assert.equal(result.failures.length, 4);
    }
    for (const sourceCommit of [undefined, "b".repeat(40)]) {
      const result = await auditEvidenceManifest(value.manifest, {
        ...value.context,
        inspectImage: async () => ({ available: true, sourceCommit }),
      });
      assert.equal(result.verified, 0);
      assert.equal(result.failures.length, 3);
      assert.ok(
        result.failures.every((failure) => failure.includes("image source")),
      );
    }
  } finally {
    await value.cleanup();
  }
});

test("EVIDENCE-AUDIT-05: exact requirement/oracle, covered clauses and named UTC review are required", async () => {
  const value = await fixture();
  try {
    const original = value.manifest.gates["DEV-01"]!;
    for (const mutation of [
      { requirement: "Reduced requirement" },
      { positiveReviewOracle: "Reduced oracle" },
      { coveredClauses: [] },
      { remainingClauses: undefined },
      { reviewer: " " },
      { reviewerUTC: "2026-10-02T00:00:00+05:30" },
      { reviewerUTC: "2026-02-30T00:00:00.000Z" },
      { reviewerUTC: "invalid" },
      { testCases: [] },
      { candidateCommit: "b".repeat(40) },
    ]) {
      const result = await auditEvidenceManifest(
        {
          ...value.manifest,
          gates: {
            ...value.manifest.gates,
            "DEV-01": { ...original, ...mutation },
          },
        },
        value.context,
      );
      assert.equal(result.verified, 204);
      assert.equal(result.acceptanceReady, false);
      assert.ok(
        result.failures.every((failure) => failure.startsWith("DEV-01:")),
      );
    }
  } finally {
    await value.cleanup();
  }
});

test("EVIDENCE-AUDIT-06: changed or unavailable real artifact bytes reject retained checksums", async () => {
  const value = await fixture();
  try {
    await writeFile(value.artifactPath, "Changed artifact bytes\n");
    const changed = await auditEvidenceManifest(value.manifest, value.context);
    assert.equal(changed.verified, 0);
    assert.equal(changed.failures.length, 205);
    assert.ok(
      changed.failures.every((failure) =>
        failure.includes("checksum mismatch"),
      ),
    );
    await rm(value.artifactPath);
    const missing = await auditEvidenceManifest(value.manifest, value.context);
    assert.equal(missing.verified, 0);
    assert.equal(missing.failures.length, 205);
    assert.ok(
      missing.failures.every((failure) =>
        failure.includes("artifact unavailable"),
      ),
    );
  } finally {
    await value.cleanup();
  }
});

test("EVIDENCE-AUDIT-07: malformed manifests produce refusals without accepting missing records", async () => {
  const value = await fixture();
  try {
    for (const malformed of [null, [], true, "manifest", { gates: [] }]) {
      const result = await auditEvidenceManifest(malformed, value.context);
      assert.equal(result.verified, 0);
      assert.equal(result.acceptanceReady, false);
    }
    const result = await auditEvidenceManifest(
      {
        ...value.manifest,
        gates: { ...value.manifest.gates, "UNKNOWN-01": {} },
      },
      value.context,
    );
    assert.equal(result.locallyValidGateEvidence, 205);
    assert.equal(result.verified, 0);
    assert.equal(result.acceptanceReady, false);
    assert.match(result.failures.join("\n"), /not in the candidate checklist/);
    for (const incomplete of [
      requirements.slice(1),
      [...requirements.slice(1), requirements[1]!],
    ]) {
      const result = await auditEvidenceManifest(value.manifest, {
        ...value.context,
        requirements: incomplete,
      });
      assert.equal(result.verified, 0);
      assert.equal(result.acceptanceReady, false);
      assert.match(result.failures.join("\n"), /complete 205 unique v1/);
    }
  } finally {
    await value.cleanup();
  }
});
