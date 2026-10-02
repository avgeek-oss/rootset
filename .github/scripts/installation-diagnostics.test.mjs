import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyChildFailure,
  dockerHostSummary,
  failureContainerSummaries,
} from "./installation-diagnostics.mjs";

const secret = "PRIVATE_INSTALLATION_SENTINEL";

test("Docker host summary requires actual positive finite resource counts", () => {
  assert.deepEqual(
    dockerHostSummary({
      NCPU: 2,
      MemTotal: 8 * 1024 ** 3,
      ServerVersion: "29.5.3",
    }),
    { availableCPUs: 2, memoryBytes: 8 * 1024 ** 3, dockerVersion: "29.5.3" },
  );
  for (const NCPU of [0, -1, NaN, 1.5, undefined])
    assert.throws(() => dockerHostSummary({ NCPU, MemTotal: 8 * 1024 ** 3 }));
  assert.throws(() => dockerHostSummary({ NCPU: 2, MemTotal: 0 }));
});

test("child failure categories never return raw credentials or error input", () => {
  const cases = [
    [
      "range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available",
      "cpu_limit_exceeds_host",
    ],
    ["no space left on device", "docker_storage_exhausted"],
    ["no matching manifest for linux/arm64", "image_platform_unavailable"],
    ["bind source path does not exist", "bind_source_missing"],
    ["Cannot connect to the Docker daemon", "docker_daemon_unavailable"],
    [
      "container rootset-install-api-1 is unhealthy",
      "container_start_or_health_failure",
    ],
    ["unknown child failure", "unclassified"],
  ];
  for (const [text, category] of cases) {
    const result = classifyChildFailure({
      stderr: Buffer.from(
        `${secret}: ${text}; postgres://owner:${secret}@db/rootset`,
      ),
      stdout: secret,
      message: secret,
    });
    assert.equal(result.category, category);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(result).includes("postgres://"));
  }
  assert.equal(classifyChildFailure({ stderr: cases[0][0] }).availableCPUs, 2);
  assert.deepEqual(classifyChildFailure({ stderr: { secret } }), {
    category: "unclassified",
  });
});

test("failed container summaries exclude environment, raw health logs and daemon errors", () => {
  const container = {
    Config: {
      Labels: {
        "com.docker.compose.project": "rootset-install-fixture",
        "com.docker.compose.service": "api",
      },
      Env: [`PASSWORD=${secret}`],
    },
    Image: `sha256:${"a".repeat(64)}`,
    State: {
      Running: false,
      ExitCode: 1,
      OOMKilled: false,
      Error: secret,
      Health: { Status: "unhealthy", Log: [{ Output: secret }] },
    },
    HostConfig: { Memory: 1024 ** 3, MemorySwap: 1024 ** 3, NanoCpus: 2e9 },
  };
  const result = failureContainerSummaries(
    [container],
    "rootset-install-fixture",
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].health, "unhealthy");
  assert.equal(result[0].memoryBytes, result[0].memoryPlusSwapBytes);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(failureContainerSummaries([container], "other-project"), []);
});
