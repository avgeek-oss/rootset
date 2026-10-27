"use client";

import { useLayoutEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { currentWorkspaceId, selectWorkspace } from "@rootset/web-client";

export function useSwitchWorkspace() {
  const router = useRouter();
  const cache = useQueryClient();
  return (workspaceId: string) => {
    void cache.invalidateQueries({
      queryKey: ["workspaces"],
      refetchType: "none",
    });
    router.push(`/databases?workspaceId=${encodeURIComponent(workspaceId)}`);
  };
}

export function useCommittedWorkspace(workspaceId: string | undefined) {
  useLayoutEffect(() => {
    // Keep requests from the visible page in its workspace until navigation commits.
    if (workspaceId && currentWorkspaceId() !== workspaceId)
      selectWorkspace(workspaceId);
  }, [workspaceId]);
}
