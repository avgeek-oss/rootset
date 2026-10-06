import { RootsetApp } from "../../components/rootset-app";
import { Suspense } from "react";

export default function Page() {
  return (
    <Suspense fallback={<p role="status">Loading Rootset…</p>}>
      <RootsetApp />
    </Suspense>
  );
}
