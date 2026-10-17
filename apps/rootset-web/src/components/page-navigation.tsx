"use client";

import {
  createContext,
  Suspense,
  useContext,
  useDeferredValue,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  hashKey,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseQueryOptions,
} from "@tanstack/react-query";

interface PageReadiness {
  location: string;
  committed: boolean;
  reads: Map<string, { promise: Promise<unknown>; settled: boolean }>;
}
const PageReadinessContext = createContext<PageReadiness | null>(null);
const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function PageLoading() {
  return (
    <div className="grid min-h-dvh place-items-center" role="status">
      Loading Rootset…
    </div>
  );
}

/** Keep the committed route visible while the next route prepares its data. */
export function PageNavigation({
  location,
  children,
}: {
  location: string;
  children: (location: string) => ReactNode;
}) {
  const destinations = useRef(new Map<string, PageReadiness>());
  let destination = destinations.current.get(location);
  if (!destination) {
    destination = { location, committed: false, reads: new Map() };
    destinations.current.set(location, destination);
  }
  const displayed = useDeferredValue(destination);
  const hydrated = useSyncExternalStore(
    subscribe,
    clientSnapshot,
    serverSnapshot,
  );
  if (!hydrated) return <PageLoading />;
  return (
    <Suspense fallback={<PageLoading />}>
      <PageContent readiness={displayed} destinations={destinations.current}>
        {children(displayed.location)}
      </PageContent>
    </Suspense>
  );
}

function PageContent({
  readiness,
  destinations,
  children,
}: {
  readiness: PageReadiness;
  destinations: Map<string, PageReadiness>;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    readiness.committed = true;
    readiness.reads.clear();
    for (const location of destinations.keys()) {
      if (location !== readiness.location) destinations.delete(location);
    }
  }, [readiness, destinations]);
  return (
    <PageReadinessContext.Provider value={readiness}>
      {children}
    </PageReadinessContext.Provider>
  );
}

export function usePageQuery<T>(
  options: Omit<UseQueryOptions<T, Error, T, QueryKey>, "enabled"> & {
    enabled?: boolean;
  },
  { fresh = false }: { fresh?: boolean } = {},
) {
  const readiness = useContext(PageReadinessContext);
  const client = useQueryClient();
  // A suspended destination has no mounted observer yet. Retain its completed
  // reads long enough for React to commit, including queries normally kept for 0ms.
  const retainedOptions = {
    retryOnMount: false,
    refetchOnMount: false,
    ...options,
    gcTime: Math.max(options.gcTime ?? 60_000, 60_000),
  };
  const query = useQuery(retainedOptions);
  if (readiness && !readiness.committed && options.enabled !== false) {
    const key = hashKey(options.queryKey);
    let read = readiness.reads.get(key);
    if (read?.settled && query.isPending) {
      readiness.reads.delete(key);
      read = undefined;
    }
    if (
      !read &&
      (query.isPending ||
        query.isError ||
        fresh ||
        (query.data !== undefined && (query.isStale || query.isFetching)))
    ) {
      const pending = {
        settled: false,
        promise: Promise.resolve<unknown>(undefined),
      };
      pending.promise = client
        .fetchQuery({
          ...retainedOptions,
          ...(fresh || query.isFetching ? { staleTime: 0 } : {}),
        })
        .then(
          () => {
            pending.settled = true;
          },
          () => {
            pending.settled = true;
          },
        );
      readiness.reads.set(key, pending);
      read = pending;
    }
    // Failure releases navigation to the page's existing error/retry UI.
    if (read && !read.settled) throw read.promise;
  }
  return query;
}
