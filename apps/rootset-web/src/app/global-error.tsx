"use client";

import { RootsetErrorState } from "../components/rootset-error-state";
import "./globals.css";

export default function GlobalError({ retry }: { retry: () => void }) {
  return (
    <html lang="en">
      <body>
        <RootsetErrorState code={500} onRetry={retry} />
      </body>
    </html>
  );
}
