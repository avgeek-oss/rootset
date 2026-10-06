"use client";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import type { JsonValue } from "@rootset/contracts";

export function JobResultDetails({
  result,
  openArtifact,
}: {
  result: JsonValue;
  openArtifact: (id: string, kind: "result" | "rejection") => void;
}) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return null;
  const counts = [
    ["Committed", result.committed],
    ["Inserted", result.inserted],
    ["updated", result.updated],
    ["rejected", result.rejected],
  ].filter((entry): entry is [string, number] => typeof entry[1] === "number");
  const artifactId =
    typeof result.artifactId === "string" ? result.artifactId : undefined;
  const rejectionId =
    typeof result.rejectionArtifactId === "string"
      ? result.rejectionArtifactId
      : typeof result.reportArtifactId === "string"
        ? result.reportArtifactId
        : undefined;
  return (
    <>
      {counts.length > 0 && (
        <p className="settings-muted">
          {counts.map(([label, value], index) => (
            <span key={label}>
              {index > 0 && " · "}
              {label} {value.toLocaleString()}
            </span>
          ))}
        </p>
      )}
      {artifactId && (
        <Button
          variant="secondary"
          onPress={() => openArtifact(artifactId, "result")}
        >
          Download result
        </Button>
      )}
      {rejectionId && (
        <Button
          variant="secondary"
          onPress={() => openArtifact(rejectionId, "rejection")}
        >
          Download rejection report
        </Button>
      )}
    </>
  );
}
