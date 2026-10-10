import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { QueryLoading } from "@avgeek-oss/design-system/patterns/feedback/query-state";
import { themeBootstrapScript } from "@avgeek-oss/design-system/lib/theme";
import { RootsetApp } from "../components/rootset-app";
import "./globals.css";
import { Providers } from "../components/providers";

export const metadata: Metadata = {
  title: "Rootset",
  description: "Simple MDM structured storage",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const apiOrigin = process.env.ROOTSET_PUBLIC_API_ORIGIN;
  if (!apiOrigin)
    throw new Error("ROOTSET_PUBLIC_API_ORIGIN must be configured.");
  const apiURL = new URL(apiOrigin);
  if (
    apiURL.origin !== apiOrigin ||
    (apiURL.protocol !== "https:" &&
      !(
        apiURL.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(apiURL.hostname)
      ))
  )
    throw new Error(
      "ROOTSET_PUBLIC_API_ORIGIN must be an HTTPS or loopback HTTP origin.",
    );
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          id="color-scheme-bootstrap"
          dangerouslySetInnerHTML={{ __html: themeBootstrapScript }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__ROOTSET_API_ORIGIN=${JSON.stringify(apiURL.origin).replace(/</g, "\\u003c")};`,
          }}
        />
      </head>
      <body>
        <Providers>
          <Suspense fallback={<QueryLoading />}>
            <RootsetApp />
          </Suspense>
          {children}
        </Providers>
      </body>
    </html>
  );
}
