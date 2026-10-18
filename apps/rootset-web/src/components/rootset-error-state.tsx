"use client";

import { Component, type ReactNode } from "react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { RootsetEmptyState } from "./rootset-empty-state";
import { Database, RefreshCw } from "./ui/icons";

export function RootsetErrorState({
  code,
  onRetry,
}: {
  code: 404 | 500;
  onRetry?: () => void;
}) {
  return (
    <main className="grid min-h-[60dvh] w-full min-w-0 content-center p-4 sm:p-6">
      <RootsetEmptyState
        variant="sad"
        title={
          code === 404 ? "Page not found" : "This page could not be loaded"
        }
        description={
          code === 404
            ? "This page may have moved, or you may no longer have access to it."
            : "Rootset could not load this page. Try again, or return to your databases."
        }
      >
        {onRetry && (
          <Button variant="secondary" onPress={onRetry}>
            <RefreshCw />
            Try again
          </Button>
        )}
        <Button onPress={() => location.assign("/databases")}>
          <Database />
          Return to databases
        </Button>
      </RootsetEmptyState>
    </main>
  );
}

export class RootsetErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <RootsetErrorState
        code={500}
        onRetry={() => this.setState({ failed: false })}
      />
    ) : (
      this.props.children
    );
  }
}
