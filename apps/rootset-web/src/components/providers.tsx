"use client";
import { Providers as DesignSystemProviders } from "@avgeek-oss/design-system";
import { NextNavigationProvider } from "@avgeek-oss/design-system/adapters/next";
import { Toast } from "@avgeek-oss/design-system/overlays/toast";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { BackendRecovery } from "./backend-recovery";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: 30_000,
            gcTime: 60_000,
            refetchOnWindowFocus: true,
          },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <DesignSystemProviders>
        <NextNavigationProvider>
          <BackendRecovery>{children}</BackendRecovery>
          <Toast.Provider placement="top end" />
        </NextNavigationProvider>
      </DesignSystemProviders>
    </QueryClientProvider>
  );
}
