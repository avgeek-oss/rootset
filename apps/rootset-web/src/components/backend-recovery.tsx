"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  BackendUnavailable,
  useBackendReconnect,
} from "@avgeek-oss/design-system";
import {
  BACKEND_UNAVAILABLE_EVENT,
  browserApiOrigin,
  RootsetClient,
} from "@rootset/web-client";
import { authClient } from "../lib/auth-client";

const probeClient = new RootsetClient({
  baseUrl: () => `${browserApiOrigin()}/v1`,
});

export function BackendRecovery({ children }: { children: ReactNode }) {
  const [unavailable, setUnavailable] = useState(false);
  const failures = useRef(0);
  const queryClient = useQueryClient();
  useEffect(() => {
    const onUnavailable = () => {
      failures.current += 1;
      setUnavailable(true);
    };
    window.addEventListener(BACKEND_UNAVAILABLE_EVENT, onUnavailable);
    return () =>
      window.removeEventListener(BACKEND_UNAVAILABLE_EVENT, onUnavailable);
  }, []);
  useBackendReconnect(unavailable, async (signal) => {
    const previousFailures = failures.current;
    await probeClient.request("/setup", { signal });
    await authClient.getSession({ fetchOptions: { signal } });
    await queryClient.refetchQueries({ type: "active" });
    if (signal.aborted || previousFailures !== failures.current) return false;
    setUnavailable(false);
    return true;
  });

  return (
    <>
      {unavailable &&
        createPortal(
          <BackendUnavailable
            appName="Rootset"
            data-rootset-backend-unavailable
            data-react-aria-top-layer
            className="fixed inset-0 z-[calc(var(--z-index-toast)+1)]"
          />,
          document.body,
        )}
      <div hidden={unavailable}>{children}</div>
    </>
  );
}
