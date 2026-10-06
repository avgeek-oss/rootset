import { createHash } from "node:crypto";

export interface EvidenceRequirement {
  id: string;
  requirement: string;
}

export interface EvidenceAuditContext {
  candidateVersion: string;
  requirements: EvidenceRequirement[];
  readArtifact: (path: string) => Promise<Uint8Array>;
}

export interface EvidenceAuditResult {
  requiredChecks: number;
  reportedPassed: number;
  validRecords: number;
  reportComplete: boolean;
  acceptanceReady: false;
  failures: string[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const utc = (value: unknown): boolean =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);

/** Validates recorded results. It cannot establish product behavior or acceptance. */
export async function auditEvidenceManifest(
  input: unknown,
  context: EvidenceAuditContext,
): Promise<EvidenceAuditResult> {
  const failures: string[] = [];
  const requiredIds = new Set(context.requirements.map(({ id }) => id));
  if (
    context.requirements.length !== 40 ||
    requiredIds.size !== 40 ||
    context.requirements.some(
      ({ id }) => !/^V1-(?:0[1-9]|[1-3]\d|40)$/.test(id),
    )
  )
    failures.push(
      "The current 40 unique V1 checklist requirements are required",
    );
  const manifest = object(input);
  if (!manifest) failures.push("Candidate report must be an object");
  if (
    !nonempty(context.candidateVersion) ||
    manifest?.candidateVersion !== context.candidateVersion
  )
    failures.push("Candidate version does not match the requested review");
  const checks = object(manifest?.checks);
  if (!checks) failures.push("Check records must be an object");
  for (const id of Object.keys(checks ?? {}))
    if (!requiredIds.has(id))
      failures.push(`${id}: not in the current checklist`);
  let reportedPassed = 0,
    validRecords = 0;
  for (const requirement of context.requirements) {
    const before = failures.length;
    const record = object(checks?.[requirement.id]);
    const fail = (message: string) =>
      failures.push(`${requirement.id}: ${message}`);
    if (!record) {
      fail("result record missing");
      continue;
    }
    if (record.requirement !== requirement.requirement)
      fail("requirement does not match the current checklist");
    if (record.status === "passed") reportedPassed++;
    else if (record.status !== "failed" && record.status !== "pending")
      fail("status must be passed, failed or pending");
    if (
      !nonempty(record.method) ||
      !nonempty(record.environment) ||
      !nonempty(record.result)
    )
      fail("method, environment and result are required");
    if (!utc(record.recordedAt)) fail("valid UTC result date is required");
    if (
      !Array.isArray(record.limitations) ||
      !record.limitations.every(nonempty)
    )
      fail("remaining limitations must be a string array");
    if (
      !Array.isArray(record.artifacts) ||
      (record.status !== "pending" && !record.artifacts.length)
    )
      fail("executed checks require result artifacts");
    else
      for (const value of record.artifacts) {
        const artifact = object(value);
        if (
          !artifact ||
          !nonempty(artifact.path) ||
          typeof artifact.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(artifact.sha256)
        ) {
          fail("artifact path or checksum is invalid");
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
    if (failures.length === before) validRecords++;
  }
  return {
    requiredChecks: context.requirements.length,
    reportedPassed,
    validRecords,
    reportComplete: failures.length === 0,
    acceptanceReady: false,
    failures,
  };
}
