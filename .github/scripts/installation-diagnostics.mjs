import assert from "node:assert/strict";

export function dockerHostSummary(info) {
  assert.ok(Number.isSafeInteger(info.NCPU) && info.NCPU > 0);
  assert.ok(Number.isSafeInteger(info.MemTotal) && info.MemTotal > 0);
  return {
    availableCPUs: info.NCPU,
    memoryBytes: info.MemTotal,
    dockerVersion: /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(info.ServerVersion)
      ? info.ServerVersion
      : "unavailable",
  };
}

export function classifyChildFailure(error) {
  const text = Buffer.isBuffer(error?.stderr)
    ? error.stderr.subarray(0, 65_536).toString("utf8")
    : typeof error?.stderr === "string"
      ? error.stderr.slice(0, 65_536)
      : "";
  const range = text.match(
    /range of CPUs is from [\d.]+ to [\d.]+, as there are only (\d+) CPUs available/i,
  );
  if (range) {
    const availableCPUs = Number(range[1]);
    return {
      category: "cpu_limit_exceeds_host",
      ...(Number.isSafeInteger(availableCPUs) && availableCPUs > 0
        ? { availableCPUs }
        : {}),
    };
  }
  if (/no space left on device|disk quota exceeded/i.test(text))
    return { category: "docker_storage_exhausted" };
  if (/no matching manifest|no match for platform/i.test(text))
    return { category: "image_platform_unavailable" };
  if (/bind source path does not exist/i.test(text))
    return { category: "bind_source_missing" };
  if (/cannot connect to the Docker daemon/i.test(text))
    return { category: "docker_daemon_unavailable" };
  if (/container .+ is unhealthy|dependency .+ failed to start/i.test(text))
    return { category: "container_start_or_health_failure" };
  return { category: "unclassified" };
}

const services = new Set([
  "postgres",
  "migrate",
  "objects",
  "objects-init",
  "mail",
  "worker",
  "api",
  "web",
]);

export function failureContainerSummaries(containers, project) {
  return containers
    .filter(
      (container) =>
        container.Config?.Labels?.["com.docker.compose.project"] === project &&
        services.has(container.Config.Labels["com.docker.compose.service"]),
    )
    .map((container) => ({
      service: container.Config.Labels["com.docker.compose.service"],
      imageId: /^sha256:[0-9a-f]{64}$/.test(container.Image)
        ? container.Image
        : null,
      running: container.State.Running === true,
      exitCode: Number.isSafeInteger(container.State.ExitCode)
        ? container.State.ExitCode
        : null,
      oomKilled: container.State.OOMKilled === true,
      health: ["starting", "healthy", "unhealthy"].includes(
        container.State.Health?.Status,
      )
        ? container.State.Health.Status
        : null,
      memoryBytes: container.HostConfig.Memory,
      memoryPlusSwapBytes: container.HostConfig.MemorySwap,
      cpuQuota: container.HostConfig.NanoCpus / 1e9,
    }));
}
