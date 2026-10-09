// Adapted from Towbar's EmailShell at bf3354d7e3c9a8d9ec634b5057fd42a11b6edba2.
// Rootset changes: branding, local fonts, same-origin links, context and security copy.
// Licensed under Apache-2.0. See ../LICENSE-Towbar and ../THIRD_PARTY_NOTICES.md.
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import React from "react";

export interface EmailShellProps {
  logoUrl: string;
  title: string;
  body: string;
  name?: string;
  context?: string;
  actionUrl?: string;
  actionLabel?: string;
}
const theme = {
  fontFamily:
    'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
  surface: "#ffffff",
  foreground: "#18181b",
  muted: "#71717a",
  accent: "#514127",
};
export function EmailShell({
  logoUrl,
  title,
  body,
  name,
  context,
  actionUrl,
  actionLabel,
}: EmailShellProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{body}</Preview>
      <Body
        style={{
          backgroundColor: theme.surface,
          color: theme.foreground,
          fontFamily: theme.fontFamily,
          WebkitFontSmoothing: "antialiased",
          margin: 0,
          padding: 0,
        }}
      >
        <Container style={{ maxWidth: 560, padding: "32px 24px" }}>
          <Text
            style={{
              fontFamily: theme.fontFamily,
              fontSize: 18,
              fontWeight: 600,
              margin: "0 0 24px",
            }}
          >
            <Img
              src={logoUrl}
              alt=""
              width={32}
              height={32}
              style={{
                display: "inline-block",
                verticalAlign: "middle",
                marginRight: 10,
              }}
            />
            Rootset
          </Text>
          <Heading
            as="h1"
            style={{
              color: theme.foreground,
              fontFamily: theme.fontFamily,
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: "-0.6px",
              lineHeight: "32px",
              margin: "0 0 20px",
            }}
          >
            {title}
          </Heading>
          <Text
            style={{
              color: theme.foreground,
              fontFamily: theme.fontFamily,
              fontSize: 16,
              lineHeight: "24px",
              margin: "0 0 16px",
            }}
          >
            {name ? `Hello ${name},` : "Hello,"}
          </Text>
          <Text
            style={{
              color: theme.foreground,
              fontFamily: theme.fontFamily,
              fontSize: 16,
              lineHeight: "24px",
              margin: "0 0 16px",
            }}
          >
            {body}
          </Text>
          {context ? (
            <Text
              style={{
                fontSize: 14,
                lineHeight: "20px",
                whiteSpace: "pre-line",
                margin: "0 0 16px",
              }}
            >
              {context}
            </Text>
          ) : null}
          {actionUrl ? (
            <Section style={{ margin: "24px 0" }}>
              <Button
                href={actionUrl}
                style={{
                  backgroundColor: theme.accent,
                  color: theme.surface,
                  borderRadius: 8,
                  padding: "10px 16px",
                  fontFamily: theme.fontFamily,
                  fontSize: 14,
                  fontWeight: 500,
                  lineHeight: "20px",
                  textDecoration: "none",
                }}
              >
                {actionLabel ?? "Open Rootset"}
              </Button>
              <Text
                style={{
                  fontFamily: theme.fontFamily,
                  fontSize: 14,
                  lineHeight: "20px",
                  color: theme.muted,
                  overflowWrap: "anywhere",
                  margin: "28px 0 0",
                }}
              >
                Or open this link:{" "}
                <Link
                  href={actionUrl}
                  style={{
                    color: theme.accent,
                    textDecoration: "underline",
                    overflowWrap: "anywhere",
                  }}
                >
                  {actionUrl}
                </Link>
              </Text>
            </Section>
          ) : null}
          <Text
            style={{
              color: theme.muted,
              fontFamily: theme.fontFamily,
              fontSize: 12,
              lineHeight: "16px",
              margin: "24px 0 0",
            }}
          >
            If you did not request this, contact your installation operator.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
