import { RootsetApp } from "../../components/rootset-app";
import { Suspense } from "react";
import { QueryLoading } from "@avgeek-oss/design-system/patterns/feedback/query-state";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={<QueryLoading />}>
      <RootsetApp />
    </Suspense>
  );
}
