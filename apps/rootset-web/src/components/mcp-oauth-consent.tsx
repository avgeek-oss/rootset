"use client";
import { useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  McpAuthorization,
  AuthScreen,
  type McpAccessLevel,
} from "@avgeek-oss/design-system";
import { client, ApiError } from "@rootset/web-client";
import { AuthBrand } from "./auth-frame";
import { ReauthenticationDialog } from "./settings/account/reauthentication-dialog";
import {
  QueryError,
  QueryLoading,
} from "@avgeek-oss/design-system/patterns/feedback/query-state";
import { McpClientLogo } from "./settings/account/mcp-client-logo";

export function ConsentScreen() {
  const id = useSearchParams().get("requestId");
  return <ConsentRequest key={id} requestId={id} />;
}
function ConsentRequest({ requestId }: { requestId: string | null }) {
  const request = useQuery({
    queryKey: ["oauth-request", requestId],
    queryFn: ({ signal }) =>
      client.request<{
        client: { id: string; name: string };
        availableAccessLevels: McpAccessLevel[];
      }>(`/oauth/requests/${encodeURIComponent(requestId ?? "")}`, { signal }),
    enabled: !!requestId,
  });
  const security = useQuery({
    queryKey: ["consent-security"],
    queryFn: ({ signal }) =>
      client.request<{ twoFactorEnabled: boolean }>("/me/security", { signal }),
    enabled: !!request.data,
  });
  const [accessLevel, setAccessLevel] = useState<McpAccessLevel>("read");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [needsProof, setNeedsProof] = useState(false);
  const inFlight = useRef(false);
  async function decide(approve: boolean, proofVerified = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      const result = await client.request<{ redirectUri: string }>(
        `/oauth/requests/${encodeURIComponent(requestId ?? "")}/decision`,
        {
          method: "POST",
          body: approve ? { approve, accessLevel } : { approve },
        },
      );
      location.assign(result.redirectUri);
    } catch (failure) {
      if (
        failure instanceof ApiError &&
        [
          "STEP_UP_REQUIRED",
          "RECENT_AUTH_REQUIRED",
          "interaction_required",
        ].includes(failure.code)
      )
        setNeedsProof(true);
      else
        setError(
          failure instanceof Error
            ? failure.message
            : "Unable to connect this app.",
        );
      inFlight.current = false;
      setPending(false);
      if (proofVerified) throw failure;
    }
  }
  if (!requestId || request.isError || security.isError || !request.data)
    return (
      <AuthScreen brand={<AuthBrand />} title="Connect to Rootset">
        {!requestId ? (
          <QueryError message="This connection link is incomplete. Start again from your MCP app." />
        ) : request.isError ? (
          <>
            <QueryError message={request.error.message} />
            {request.error instanceof ApiError &&
              request.error.status === 401 && (
                <a
                  href={`/login?returnTo=${encodeURIComponent(`/oauth/consent?requestId=${requestId}`)}`}
                >
                  Sign in to continue
                </a>
              )}
          </>
        ) : security.isError ? (
          <QueryError message={security.error.message} />
        ) : (
          <QueryLoading />
        )}
      </AuthScreen>
    );
  return (
    <>
      <McpAuthorization
        brand={<AuthBrand />}
        productName="Rootset"
        clientName={request.data.client.name}
        clientLogo={
          <McpClientLogo
            client={
              request.data.client.id.startsWith(
                "https://chatgpt.com/oauth/codex/",
              )
                ? "codex"
                : "unknown"
            }
          />
        }
        accessLevel={accessLevel}
        availableAccessLevels={request.data.availableAccessLevels}
        onAccessLevelChange={setAccessLevel}
        isPending={pending}
        error={error}
        isDisabled={!security.data}
        onApprove={() => void decide(true)}
        onDeny={() => void decide(false)}
      />
      <ReauthenticationDialog
        isOpen={needsProof && !!security.data}
        onOpenChange={setNeedsProof}
        hasPasskey={Boolean(security.data?.twoFactorEnabled)}
        onConfirmed={async () => {
          await decide(true, true);
          setNeedsProof(false);
        }}
      />
    </>
  );
}
