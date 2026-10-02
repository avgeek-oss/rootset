import assert from "node:assert/strict";
import { format } from "prettier";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { requirements, type Requirement } from "./gate-audit.js";
import { root } from "./environment.js";
import { sourceProvenance } from "./source-provenance.js";
import { gateReviewOracles } from "./gate-review-oracles.js";

type Issue = {
  id: string;
  gates: string[];
  kind: "implementation" | "verification";
  priority: number;
  finding: string;
  action: string;
  sources: string[];
};

// Findings are observations of a changing development tree. A fix remains open
// here until the complete requirement has been independently reverified.
const issues: Issue[] = [
  {
    id: "RETENTION-01",
    gates: ["AUD-09", "ACC-10", "DB-12", "BKP-04", "BKP-07"],
    kind: "verification",
    priority: 1,
    finding:
      "The initial missing archive/deleted-organisation maintenance executors are implemented. Jobs reports 39 real PostgreSQL/S3 cases passing on each MinIO/RustFS, including verified encrypted archives before fenced purge, interruption without duplicated hot/cold events, cold-history restore and configured deleted-org retention with default indefinite preservation. Complete requirement review, candidate reruns and genuine crash boundaries remain open.",
    action:
      "Independently rerun the published archive/deletion cases on the final source, inspect every retained history layer and peer-resource oracle, and review policy/manifest/gap/backup semantics against every exact clause. Complete process interruption and actual reviewer runbook evidence.",
    sources: [
      "rc-plan/MDM_DATABASE_ARCHITECTURE.md:116",
      "packages/table-storage/src/index.ts#iterateSnapshotHistory",
      "packages/table-storage/src/index.ts#queryHistory",
      "packages/jobs/src/index.ts#applyRetention",
      "packages/jobs/src/index.ts#cleanupArtifacts",
      "packages/identity/src/index.ts#finishDeletion",
      "packages/database/migrations/013_operation_outcomes.sql#worker_org_directory",
    ],
  },
  {
    id: "READINESS-01",
    gates: ["OPS-02", "API-10"],
    kind: "verification",
    priority: 1,
    finding:
      "The initial SELECT 1-only readiness finding is fixed in the runtime factory: expected migration inventory/checksums, worker freshness, PostgreSQL, object/SMTP probes and storage admission are integrated. Current core/API tests cover focused factory/dependency behavior; complete independent outage and final installation evidence still require review.",
    action:
      "Rerun actual factory readiness and persisted installation status against missing/checksum-mismatched migrations, stale worker, PostgreSQL failure, mail/object outages and storage admission while authorised reads remain usable. Inspect dynamic journal compatibility and redacted status on final source.",
    sources: [
      "apps/rootset-api/src/app.ts#createApp",
      "packages/core/src/runtime.ts#createRuntime",
      "packages/core/src/installation.ts#status",
      "rc-plan/STACK_ARCHITECTURE.md#Observability and capacity",
    ],
  },
  {
    id: "OBSERVABILITY-01",
    gates: ["OPS-05", "OPS-06", "PERF-06", "PERF-08", "JOB-05"],
    kind: "verification",
    priority: 1,
    finding:
      "Bounded correlated request observations and actual cross-org operator aggregates are implemented and wired. Six separate-cluster integration cases and three logger tests pass, including real pool saturation, actual SMTP socket failure, expired persisted leases, old queue work, failed schema journals, stale/degraded workers, secret exclusion and unavailable metrics remaining unknown. Full background/disk/object outage and final candidate requirements remain open.",
    action:
      "Review the implemented bounded redacted operating metrics/logs and actionable status signals; exercise query timeout, disk pressure, pool saturation, SMTP/object denial, stale leases and failed schema jobs while probing foreground reads. Record background-work timings and resource effects.",
    sources: [
      "apps/rootset-api/src/index.ts",
      "apps/rootset-api/src/app.ts",
      "packages/core/src/usage.ts",
      "packages/jobs/src/index.ts#runWorker",
      "packages/database/migrations/020_usage_metrics.sql",
      "packages/database/migrations/028_operator_metrics.sql",
      "packages/observability/src/index.ts",
      "tools/verification/runtime-ownership.integration.test.ts",
      "rc-plan/STACK_ARCHITECTURE.md#Observability and capacity",
    ],
  },
  {
    id: "BACKUP-MAIL-01",
    gates: ["BKP-14"],
    kind: "verification",
    priority: 1,
    finding:
      "The initial absent runtime backup notifier is fixed. Runtime supplies durable recipient-aware outbox enqueue and delivery-state callbacks; core reports five actual PostgreSQL/Mailpit cases passing. Pending enqueue is no longer represented as sent. Full candidate backup/failure/outage/restart event evidence remains separately reviewable.",
    action:
      "Rerun the actual notifier tests and verify enabled/disabled recipients, redacted failure context, deduplication and SMTP outage/restart recovery through complete backup jobs; review notification state independently from verification state.",
    sources: [
      "packages/jobs/src/index.ts#notifyBackup",
      "packages/core/src/runtime.ts#createRuntime",
      "packages/email/src/index.ts#EmailOutbox",
    ],
  },
  {
    id: "PASTE-01",
    gates: ["UI-09", "UI-13", "IO-01", "IO-09"],
    kind: "verification",
    priority: 1,
    finding:
      "The initial strict prepareImportUpload adapter rejection is fixed by current runtime callbacks; API's real authenticated raw upload/CSRF/media/parent/current-authority/stream/replay/checksum cases pass. Final rendered large paste, durable import progress and exact data/history readback are still required before closing the browser workflow finding.",
    action:
      "Align UI upload inputs with the strict contract, then execute real rectangular small atomic paste and large preview/upload/import jobs, including rejected records, cancellation, checkpoint/retry and final data/history oracle checks.",
    sources: [
      "apps/rootset-web/src/components/spreadsheet.tsx#previewPaste",
      "apps/rootset-web/src/components/paste-import.tsx",
      "packages/contracts/src/operations.ts#prepareImportUpload",
      "packages/jobs/src/index.ts#prepareImportUpload",
    ],
  },
  {
    id: "ABANDONED-CLEANUP-01",
    gates: ["BKP-13", "IO-09", "JOB-06"],
    kind: "verification",
    priority: 1,
    finding:
      "The initially missing cleanup paths are implemented: jobs reports 24-hour owned orphan artifact cleanup, 48-hour ciphertext-only temporary cleanup and background reconciliation of failed verification namespaces. Focused actual PostgreSQL/S3 cases pass; full interruption, cleanup-denial, retained key/source preservation and final evidence still require independent review.",
    action:
      "Review actual bounded owned-namespace artifact/temp/verification cleanup, preserve recoverable source/key state and verify actual crash/restart, cleanup denial, retry and absence of peer-resource deletion.",
    sources: [
      "packages/jobs/src/index.ts#cleanupArtifacts",
      "packages/jobs/src/backups.ts",
      "packages/jobs/src/artifacts.ts",
      "packages/jobs/src/integration.ts",
    ],
  },
  {
    id: "TRANSPORT-MATRIX-01",
    gates: [
      "ACC-04",
      "ACC-12",
      "KEY-05",
      "KEY-07",
      "KEY-08",
      "FLD-13",
      "FLD-15",
      "ROW-01",
      "ROW-10",
      "AUD-05",
      "AUD-06",
      "API-02",
      "API-03",
      "API-09",
      "API-12",
      "MCP-08",
      "MCP-10",
      "MCP-11",
      "MCP-12",
      "REL-02",
      "REL-03",
    ],
    kind: "verification",
    priority: 2,
    finding:
      "Current API/OAuth suite reports 340/340 actual cases passing (final local TAP37.37s), including 323 typed REST/MCP/native/history/artifact matrix cases and complete authenticated upload regressions. The generated-client workflow and sensitive delegated key approval pass. Successful transport diagnostic now covers37 catalog classes;104 discovery/authentication checks remain separate. Enumerating routes/tools or this typed matrix does not prove successful and denied execution of every remaining administration/destructive/job operation class.",
    action:
      "Finish the exact same typed accepted/rejected cases through service/browser/REST/MCP and the role x session/personal/team/OAuth x target matrix. Exercise all destructive/job/credential/approval operation classes with authoritative values, revisions, history and terminal results, including revocation between requests.",
    sources: [
      "apps/rootset-api/src/runtime.test.ts",
      "apps/rootset-api/src/http.test.ts",
      "tools/verification/access.integration.test.ts",
      "packages/contracts/generated/operation-inventory.json",
      "packages/contracts/generated/mcp-tools.json",
    ],
  },
  {
    id: "BROWSER-SECURITY-01",
    gates: [
      "AUTH-01",
      "AUTH-05",
      "AUTH-06",
      "AUTH-09",
      "AUTH-11",
      "AUTH-14",
      "UI-14",
      "UI-16",
    ],
    kind: "verification",
    priority: 2,
    finding:
      "Actual PostgreSQL auth and factor tests exist. Native browser passkey ceremony, wrong RP/origin, replay/expiry/user-verification negatives and the final rendered factor/consent screens still need actual-browser evidence after the latest protocol-adapter fix.",
    action:
      "Run real browser registration/login and negative WebAuthn proofs, login/reset/verification/TOTP/recovery/consent flows, cookie/CSRF checks and redacted screenshots at desktop/mobile light/dark on final source. Preserve challenge and credential binding evidence without secret screenshots.",
    sources: [
      "packages/identity/src/identity.test.ts",
      "apps/rootset-web/src/components/auth-screen.tsx",
      "apps/rootset-web/src/components/settings/security.tsx",
      "packages/identity-web-ui/src/index.tsx",
    ],
  },
  {
    id: "BROWSER-WORKFLOWS-01",
    gates: [
      "UI-05",
      "UI-06",
      "UI-08",
      "UI-10",
      "UI-11",
      "UI-12",
      "UI-13",
      "UI-15",
      "UI-16",
      "FLD-09",
      "FLD-10",
    ],
    kind: "verification",
    priority: 2,
    finding:
      "Real editor cases and rendered settings/grid sections have partial browser evidence. Actual Chromium persistence of resize/order/hide/freeze and stale-schema draft retention/review/save now pass. Final filter draft guards, durable paste/job terminal/recovery, cross-browser reruns and accessibility review remain open. An automated axe result does not establish complete screen-reader/reduced-motion behavior.",
    action:
      "Record final rendered workflows and persisted preferences, DST ambiguity/nonexistent-time handling, history target/permission checks, conflict draft retention, cancellation/offline/revocation recovery and accessible focus announcements on Safari and Chromium.",
    sources: [
      "apps/rootset-web/src/components/spreadsheet.tsx",
      "apps/rootset-web/src/components/cells/CellEditor.browser.spec.ts",
      "apps/rootset-web/src/components/settings",
      "apps/rootset-web/src/lib/window-cache.test.ts",
    ],
  },
  {
    id: "SCALE-PROFILE-01",
    gates: [
      "PERF-01",
      "PERF-02",
      "PERF-03",
      "PERF-04",
      "PERF-05",
      "PERF-06",
      "PERF-07",
      "PERF-08",
      "QRY-10",
      "QRY-11",
      "AUD-10",
    ],
    kind: "verification",
    priority: 2,
    finding:
      "The actual5M/24-field/958-byte-average,200-field/65,536-byte and10M-history fixtures exist. Original warm service/ten-client/capacity/deep-window/timeout results remain development evidence. The user approved a new maximum8GiB total server budget, with unchanged latency/cache/fixture thresholds; final PG4/API1/worker2/web1GiB cgroup deployment and cold/HTTP/network/scanning/background/browser/restart measurements are in progress. Native Safari requires the Mac to be unlocked; WebKit evidence is separately identified.",
    action:
      "Record actual enforced four-service8GiB budgets and external dependency costs separately. Complete at least1,000-request cold/warm actual HTTP scenarios with explicit PostgreSQL-buffer/OS-cache scope, real network paths, unindexed selective/nonselective text/JSON/range foreground probes, background import/index/rule/conversion/backup effects, and final Safari/Chromium/restart behavior without resource growth. Keep failed samples and source/container/image provenance.",
    sources: [
      "tools/verification/scale-fixture.ts",
      "tools/verification/scale-benchmark.ts",
      "tools/verification/scale-restore-check.ts",
      "rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md#Performance profile and scale gates",
    ],
  },
  {
    id: "RECOVERY-MATRIX-01",
    gates: [
      "DB-06",
      "DB-09",
      "DB-11",
      "DB-12",
      "ROW-10",
      "UNI-07",
      "AUD-08",
      "IO-04",
      "IO-09",
      "BKP-06",
      "BKP-09",
      "BKP-10",
      "BKP-11",
      "BKP-12",
      "BKP-13",
      "JOB-02",
      "JOB-05",
      "JOB-06",
      "OPS-03",
      "OPS-04",
      "OPS-07",
      "OPS-08",
    ],
    kind: "verification",
    priority: 2,
    finding:
      "Complete 5M/10,001,048-event physical checksums pass on fresh PostgreSQL 18. A second whole-cluster restore verifies nonempty protected control data and encrypted S3 objects with retained keys. Fresh Compose and populated forward upgrades have focused evidence; the ownership upgrade now covers dropped physical schema/table metadata, retained rows/history partitions and simultaneous two-database migrations. Full failure/recovery/runbook and genuine process/network boundaries remain open.",
    action:
      "Complete the exact pre/post DDL/upload/verification/cutover process/network loss matrix, all job kinds and current-authority checks. Rehearse prior populated schema upgrade, failed upgrade recovery and fresh installation with retained keys, nonempty encrypted objects and control authentication, following written runbooks with an actual reviewer.",
    sources: [
      "packages/jobs/src/integration.ts",
      "packages/table-storage/src/index.ts#reconcileSchemaOperations",
      "packages/core/src/runtime.ts#createRuntime",
      "tools/verification/scale-restore-check.ts",
      "tools/recovery-rehearsal.mjs",
      "docs/operations/upgrade-and-recovery.md",
    ],
  },
  {
    id: "CANDIDATE-REVIEW-01",
    gates: [
      "DEV-01",
      "DEV-02",
      "DEV-03",
      "DEV-04",
      "DEV-05",
      "DEV-06",
      "DEV-07",
      "DEV-08",
      "API-01",
      "OPS-01",
      "OPS-09",
      "REL-01",
      "REL-02",
      "REL-03",
      "REL-04",
      "REL-05",
    ],
    kind: "verification",
    priority: 3,
    finding:
      "The tree is still changing. Development source digests, generated inventories, build/CI/install workflows and local observations exist, but there is no reviewed immutable candidate with every final source/image/contract/migration/dependency digest and all 205 gates signed.",
    action:
      "Freeze exact source, generate reproducible contracts/images, run clean install/build/lint/types/tests/dependency/upgrade/browser/scale checks in the candidate environment, attach exact artifacts to each gate and obtain named implementation and verification approvals. Keep publication/deployment state separate.",
    sources: [
      ".github/workflows/verify.yaml",
      "tools/evidence-audit.ts",
      "docs/verification/gate-evidence-plan.json",
      "rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md",
    ],
  },
];

const areaSources: Record<string, string[]> = {
  DEV: [
    "package.json",
    ".github/workflows/verify.yaml",
    "Dockerfile",
    "packages/contracts/src/generation.ts",
  ],
  ACC: [
    "packages/identity/src/index.ts",
    "packages/core/src/index.ts",
    "packages/access/src/index.ts",
  ],
  AUTH: [
    "packages/identity/src/index.ts",
    "packages/email/src/index.ts",
    "apps/rootset-web/src/components/auth-screen.tsx",
  ],
  KEY: [
    "packages/identity/src/index.ts",
    "packages/oauth/src/index.ts",
    "packages/core/src/config.ts",
  ],
  DB: [
    "packages/table-storage/src/index.ts",
    "packages/database/migrations",
    "packages/core/src/schema-journal.ts",
  ],
  FLD: [
    "packages/contracts/src/values.ts",
    "packages/contracts/src/decoder.ts",
    "packages/table-storage/src/index.ts",
    "apps/rootset-web/src/components/cells",
  ],
  ROW: [
    "packages/table-storage/src/index.ts",
    "packages/database/migrations/002_storage.sql",
    "packages/core/src/index.ts",
  ],
  UNI: [
    "packages/table-storage/src/index.ts",
    "packages/database/migrations/002_storage.sql",
  ],
  AUD: [
    "packages/table-storage/src/index.ts",
    "packages/database/migrations",
    "packages/identity/src/index.ts",
  ],
  QRY: [
    "packages/table-storage/src/query.ts",
    "packages/table-storage/src/index.ts",
    "packages/core/src/paging.ts",
  ],
  API: [
    "apps/rootset-api/src/app.ts",
    "apps/rootset-api/src/admission.ts",
    "packages/contracts/src/generation.ts",
  ],
  MCP: [
    "apps/rootset-api/src/app.ts",
    "packages/oauth/src/index.ts",
    "packages/contracts/src/generation.ts",
  ],
  UI: [
    "apps/rootset-web/src/components/spreadsheet.tsx",
    "apps/rootset-web/src/components/settings",
    "apps/rootset-web/src/components/cells",
  ],
  IO: [
    "packages/jobs/src/imports.ts",
    "packages/jobs/src/artifacts.ts",
    "packages/jobs/src/index.ts",
  ],
  BKP: [
    "packages/jobs/src/backups.ts",
    "packages/jobs/src/schedule.ts",
    "packages/jobs/src/index.ts",
  ],
  JOB: [
    "packages/jobs/src/queue.ts",
    "packages/jobs/src/index.ts",
    "packages/core/src/runtime.ts",
  ],
  PERF: [
    "tools/verification/scale-fixture.ts",
    "tools/verification/scale-benchmark.ts",
    "apps/rootset-web/src/components/spreadsheet.tsx",
  ],
  OPS: [
    "packages/core/src/installation.ts",
    "packages/core/src/runtime.ts",
    "docs/operations",
    "Dockerfile",
  ],
  REL: [
    "tools/evidence-audit.ts",
    "rc-plan/IMPLEMENTATION_VERIFICATION_CHECKLIST.md",
  ],
};

export async function writeGapAudit(): Promise<void> {
  const exact = await requirements();
  assert.equal(gateReviewOracles.size, exact.length);
  for (const gate of exact)
    assert.ok(
      gateReviewOracles.has(gate.id),
      `Missing whole-requirement review oracle for ${gate.id}`,
    );
  const evidence = JSON.parse(
    await readFile(
      join(root, "docs/verification/gate-evidence-plan.json"),
      "utf8",
    ),
  ) as { gates: Requirement[] };
  assert.equal(exact.length, 205);
  assert.equal(evidence.gates.length, 205);
  const report = {
    kind: "development-v1-gap-audit",
    assessedAt: new Date().toISOString(),
    provenance: await sourceProvenance(),
    scope:
      "All 205 exact requirements inventoried with source paths, partial test pointers and remaining evidence. Prioritized source/actual-route failures are reported separately from verification gaps. This is a development triage, not complete positive implementation review or candidate sign-off. Findings remain open while agents implement fixes until genuine re-verification.",
    gateSignOffs: [],
    reviewerApprovals: [],
    issues,
    gates: exact.map((gate) => {
      const linked = issues.filter((issue) => issue.gates.includes(gate.id));
      const partial = evidence.gates.find((item) => item.id === gate.id)!;
      return {
        id: gate.id,
        area: gate.area,
        requirement: gate.requirement,
        positiveReviewOracle: gateReviewOracles.get(gate.id),
        wholeRequirementReviewed: false,
        acceptanceStatus: "open",
        implementationAssessment: linked.some(
          (issue) => issue.kind === "implementation",
        )
          ? "reported-gap-awaiting-reverification"
          : "full-positive-source-review-required",
        sourcePaths: areaSources[gate.id.split("-")[0]!] ?? [],
        partialTestSources: partial.testSources,
        openIssueIds: linked.map((issue) => issue.id),
        nextActions: linked.map((issue) => issue.action),
        remainingEvidence: gate.requiredEvidence,
        finalRequirementReview:
          "Inspect every clause in this exact requirement, actual assertions/results and final candidate artifacts; a partial test pointer or empty known-issue list is not completion.",
      };
    }),
  };
  await writeFile(
    join(root, "docs/verification/gate-gap-audit.json"),
    await format(JSON.stringify(report), { parser: "json" }),
  );
  process.stdout.write(
    JSON.stringify({
      gates: report.gates.length,
      signedOff: 0,
      issues: issues.length,
    }) + "\n",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
)
  await writeGapAudit();
