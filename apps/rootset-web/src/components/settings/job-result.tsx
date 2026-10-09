"use client";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import type { JsonValue } from "@rootset/contracts";

export function JobResultDetails({
  result,
  openArtifact,
}: {
  result: JsonValue;
  openArtifact: (id: string) => void;
}) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return null;
  const artifactId =
    typeof result.artifactId === "string" ? result.artifactId : undefined;
  return (
    <>
      {typeof result.rowCount === "number" && (
        <p className="settings-muted">
          Exported {result.rowCount.toLocaleString()} rows
        </p>
      )}
      {artifactId && (
        <Button variant="secondary" onPress={() => openArtifact(artifactId)}>
          Download result
        </Button>
      )}
    </>
  );
}
