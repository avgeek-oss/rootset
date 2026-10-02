import { createHash } from "node:crypto";

export interface EvidenceRequirement {
  id: string;
  requirement: string;
  positiveReviewOracle: string;
}

export interface EvidenceAuditContext {
  candidateCommit: string;
  sourceClean: boolean;
  requirements: EvidenceRequirement[];
  readArtifact: (path: string) => Promise<Uint8Array>;
  inspectImage: (digest: string) => Promise<{
    available: boolean;
    sourceCommit?: string;
  }>;
}

export interface EvidenceAuditResult {
  requiredGates: number;
  locallyValidGateEvidence: number;
  verified: number;
  acceptanceReady: boolean;
  failures: string[];
}

const imageServices = ["postgres", "api", "worker", "web"] as const;
const commitPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/;
const checksumPattern = /^[a-f0-9]{64}$/;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonempty);
}

function utc(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

export async function auditEvidenceManifest(
  input: unknown,
  context: EvidenceAuditContext,
): Promise<EvidenceAuditResult> {
  const globalFailures: string[] = [];
  const gateFailures: string[] = [];
  if (
    context.requirements.length !== 205 ||
    new Set(context.requirements.map(({ id }) => id)).size !== 205
  )
    globalFailures.push(
      "The complete 205 unique v1 gate requirements are required",
    );
  const manifest = object(input);
  if (!manifest) globalFailures.push("Candidate manifest must be an object");
  if (
    !manifest ||
    typeof manifest.candidateCommit !== "string" ||
    !commitPattern.test(manifest.candidateCommit) ||
    manifest.candidateCommit !== context.candidateCommit
  )
    globalFailures.push("Candidate source does not match HEAD");
  if (!context.sourceClean)
    globalFailures.push("Candidate source has uncommitted changes");

  const images = object(manifest?.imageDigests);
  for (const service of imageServices) {
    const digest = images?.[service];
    if (typeof digest !== "string" || !digestPattern.test(digest)) {
      globalFailures.push(
        `${service}: immutable image digest is missing or invalid`,
      );
      continue;
    }
    try {
      const inspected = await context.inspectImage(digest);
      if (!inspected.available)
        globalFailures.push(
          `${service}: immutable image digest is not available locally`,
        );
      else if (
        service !== "postgres" &&
        inspected.sourceCommit !== context.candidateCommit
      )
        globalFailures.push(
          `${service}: immutable image source does not match HEAD`,
        );
    } catch {
      globalFailures.push(`${service}: immutable image inspection failed`);
    }
  }

  const gates = object(manifest?.gates);
  if (!gates) globalFailures.push("Gate evidence must be an object");
  const requiredIds = new Set(context.requirements.map(({ id }) => id));
  for (const id of Object.keys(gates ?? {}))
    if (!requiredIds.has(id))
      globalFailures.push(`${id}: gate is not in the candidate checklist`);

  let locallyValidGateEvidence = 0;
  for (const requirement of context.requirements) {
    const before = gateFailures.length;
    const evidence = object(gates?.[requirement.id]);
    const fail = (message: string) =>
      gateFailures.push(`${requirement.id}: ${message}`);
    if (!evidence) {
      fail("reviewed passing evidence missing");
      continue;
    }
    if (
      evidence.status !== "passed" ||
      evidence.candidateCommit !== manifest?.candidateCommit
    )
      fail("passing result for the exact candidate is missing");
    if (
      evidence.requirement !== requirement.requirement ||
      evidence.positiveReviewOracle !== requirement.positiveReviewOracle
    )
      fail("literal requirement and review oracle do not match the candidate");
    if (evidence.wholeRequirementReviewed !== true)
      fail("whole requirement has not been reviewed");
    if (!strings(evidence.coveredClauses))
      fail("reviewed oracle clauses are missing");
    if (
      !Array.isArray(evidence.remainingClauses) ||
      evidence.remainingClauses.length !== 0
    )
      fail("remaining clauses must be explicitly empty");
    if (!nonempty(evidence.reviewer) || !utc(evidence.reviewerUTC))
      fail("named reviewer and UTC review time are missing");
    if (!strings(evidence.testCases)) fail("named test cases are missing");
    if (!Array.isArray(evidence.artifacts) || !evidence.artifacts.length) {
      fail("hashed evidence artifacts are missing");
    } else {
      for (const value of evidence.artifacts) {
        const artifact = object(value);
        if (
          !artifact ||
          !nonempty(artifact.path) ||
          typeof artifact.sha256 !== "string" ||
          !checksumPattern.test(artifact.sha256)
        ) {
          fail("artifact path or SHA256 is invalid");
          continue;
        }
        try {
          const bytes = await context.readArtifact(artifact.path);
          if (
            createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
          )
            fail(`artifact checksum mismatch ${artifact.path}`);
        } catch {
          fail(`artifact unavailable ${artifact.path}`);
        }
      }
    }
    if (gateFailures.length === before) locallyValidGateEvidence++;
  }
  const failures = [...globalFailures, ...gateFailures];
  return {
    requiredGates: context.requirements.length,
    locallyValidGateEvidence,
    verified: globalFailures.length ? 0 : locallyValidGateEvidence,
    acceptanceReady: failures.length === 0,
    failures,
  };
}
