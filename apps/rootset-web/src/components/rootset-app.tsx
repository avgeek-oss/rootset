"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Input, Label, TextField } from "@heroui/react";
import { Button } from "./ui/button";
import { Database as DatabaseIcon } from "./ui/icons";
import { TablesPage } from "./tables-page";
import {
  client,
  ApiError,
  RootsetClient,
  resourcePath,
  unwrapData,
} from "@rootset/web-client";
import { IdentityCredentialsForm } from "@rootset/identity-web-ui";
import {
  ContextSchema,
  IdSchema,
  type Database,
  type Table,
  type OperatorRepairIntent,
} from "@rootset/contracts";
import type { z } from "zod";
import { RepairIntentReview } from "./repair-intent-review";
import {
  repairReviewUnavailable,
  repairReviewError,
} from "./repair-review-status";
import { AuthScreen } from "./auth-screen";
import { authClient } from "../lib/auth-client";
import { MutationAttempt } from "../lib/mutation-attempt";
import { Spreadsheet } from "./spreadsheet";
import { Dialog } from "./dialog";
import { SettingsPanel, type SettingsSection } from "./settings";
import { resolveSettingsSection, SECTION_LABELS } from "./settings/types";
import {
  dataHref,
  settingsHref,
  settingsScope,
  scopeTitles,
  PageNavigation,
} from "./settings/navigation";
import {
  ApplicationSidebar,
  AppLayout,
  FooterIdentity,
  Navbar,
  ThemeSwitcher,
  usePersistentAppSidebar,
} from "./ui/shell";
import { Dropdown } from "@heroui/react";
import { Header } from "react-aria-components";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Database01Icon,
  Settings01Icon,
  UserAccountIcon,
  UserGroupIcon,
  PlusSignIcon,
  BookOpen01Icon,
  Key01Icon,
  SecurityCheckIcon,
} from "@hugeicons/core-free-icons";

type Context = z.infer<typeof ContextSchema>;
const publicClient = new RootsetClient({ baseUrl: "/v1" });
const defaultPreferences = {
  timezone: "UTC",
  locale: "en",
  dateFormat: "YYYY-MM-DD",
  timeFormat: "24h",
  theme: "system",
} as const;

function applyTheme(theme: "system" | "light" | "dark") {
  const resolved =
    theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  document.documentElement.classList.add("no-transitions");
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      document.documentElement.classList.remove("no-transitions"),
    ),
  );
  return resolved;
}

export function RootsetApp() {
  const path = usePathname();
  const parameters = useSearchParams();
  const router = useRouter();
  const sidebar = usePersistentAppSidebar();
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");
  const queryClient = useQueryClient();
  const browserSession = authClient.useSession();
  const databaseId = parameters.get("databaseId");
  const tableId = parameters.get("tableId");
  const section = path.startsWith("/settings/") ? path.split("/")[2] : null;
  const settings = resolveSettingsSection(section ?? null);
  const [create, setCreate] = useState<"database" | "table" | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const createAttempt = useRef(new MutationAttempt());
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: ({ signal }) =>
      publicClient.request<{ claimed: boolean; verified: boolean }>("/setup", {
        signal,
      }),
    staleTime: 60_000,
  });
  const context = useQuery({
    queryKey: ["context"],
    queryFn: ({ signal }) => client.request<Context>("/context", { signal }),
    enabled: setup.data?.claimed === true,
    retry: false,
  });
  const orgId = context.data?.organisation?.id;
  const databases = useQuery({
    queryKey: ["databases", orgId],
    queryFn: async ({ signal }) =>
      unwrapData(
        await client.request<Database[] | { data: Database[] }>(
          `${resourcePath(orgId!)}/databases`,
          { signal },
        ),
      ),
    enabled: !!orgId,
  });
  const selectedDatabaseId = databaseId ?? databases.data?.[0]?.id ?? null;
  const tables = useQuery({
    queryKey: ["tables", orgId, selectedDatabaseId],
    queryFn: async ({ signal }) =>
      unwrapData(
        await client.request<Table[] | { data: Table[] }>(
          `${resourcePath(orgId!, selectedDatabaseId!)}/tables`,
          { signal },
        ),
      ),
    enabled: !!orgId && !!selectedDatabaseId,
  });
  const selectedTableId = tableId;
  const database = databases.data?.find(
    (entry) => entry.id === selectedDatabaseId,
  );
  const table = tables.data?.find((entry) => entry.id === selectedTableId);
  const preferences = context.data?.preferences ?? defaultPreferences;
  const canManage = context.data?.principal.role === "admin";
  const canCreateDatabase = canManage;
  const canEdit = canManage || context.data?.principal.role === "editor";

  const requestedOrganisation =
    parameters.get("organisationId") ?? parameters.get("orgId");
  const navigationError = [requestedOrganisation, databaseId, tableId].some(
    (value) => value && !IdSchema.safeParse(value).success,
  )
    ? "This settings link contains an invalid resource identifier."
    : requestedOrganisation && orgId && requestedOrganisation !== orgId
      ? "This settings link belongs to a different installation organisation."
      : null;

  useEffect(() => {
    setResolvedTheme(applyTheme(preferences.theme));
    const media = matchMedia("(prefers-color-scheme: dark)");
    const listener = () => {
      if (preferences.theme === "system")
        setResolvedTheme(applyTheme("system"));
    };
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [preferences.theme]);

  function refresh() {
    void queryClient.invalidateQueries();
  }

  async function createResource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(
      new FormData(event.currentTarget).get("name") ?? "",
    ).trim();
    setPending(true);
    setMutationError(null);
    try {
      if (create === "database") {
        const item = await client.request<Database>(
          `${resourcePath(orgId!)}/databases`,
          {
            method: "POST",
            body: { name },
            idempotencyKey: createAttempt.current.forInput({
              kind: "database",
              orgId,
              name,
            }),
          },
        );
        router.push(dataHref(item.id));
      } else {
        const item = await client.operation<{ table: Table }>(
          "createTable",
          {
            orgId: orgId!,
            databaseId: selectedDatabaseId!,
            name,
            fields: [],
          },
          {
            idempotencyKey: createAttempt.current.forInput({
              kind: "table",
              orgId,
              databaseId: selectedDatabaseId,
              name,
            }),
          },
        );
        router.push(dataHref(selectedDatabaseId, item.table.id));
      }
      setCreate(null);
      createAttempt.current.clear();
      refresh();
    } catch (error) {
      setMutationError(
        error instanceof Error ? error.message : "Creation failed",
      );
    } finally {
      setPending(false);
    }
  }

  if (setup.isPending || (setup.data?.claimed && context.isPending))
    return (
      <main className="startup-state" role="status">
        <span className="rootset-symbol" aria-hidden="true">
          r
        </span>
        <p>Opening Rootset…</p>
      </main>
    );
  if (setup.isError)
    return (
      <main className="startup-state">
        <h1>Rootset could not be reached</h1>
        <p role="alert">{setup.error.message}</p>
        <Button onPress={() => void setup.refetch()}>Retry connection</Button>
      </main>
    );
  if (path === "/consent" || path === "/oauth/consent")
    return <ConsentScreen />;
  if (
    path.startsWith("/account-action/") ||
    path.startsWith("/account-actions/")
  )
    return <AccountActionApproval id={path.split("/").at(-1)!} />;
  if (
    context.error instanceof ApiError &&
    context.error.status === 401 &&
    browserSession.data &&
    ![
      "/forgot-password",
      "/reset-password",
      "/verify-email",
      "/verification",
    ].includes(path) &&
    !path.startsWith("/invite/") &&
    !path.startsWith("/invitations/")
  )
    return (
      <main className="startup-state">
        <h1>No access to Rootset</h1>
        <p>Ask an administrator to invite you to this installation.</p>
        <Button
          onPress={() =>
            void authClient.signOut().then(() => location.assign("/login"))
          }
        >
          Sign out
        </Button>
      </main>
    );
  if (
    !setup.data?.claimed ||
    (context.error instanceof ApiError && context.error.status === 401) ||
    [
      "/login",
      "/forgot-password",
      "/reset-password",
      "/verify-email",
      "/verification",
    ].includes(path) ||
    path.startsWith("/invite/") ||
    path.startsWith("/invitations/")
  )
    return (
      <AuthScreen
        path={path}
        claimed={setup.data?.claimed ?? false}
        onSignedIn={() => {
          queryClient.removeQueries({ queryKey: ["context"] });
          const returnTo = new URLSearchParams(location.search).get("returnTo");
          location.assign(
            returnTo?.startsWith("/") && !returnTo.startsWith("//")
              ? returnTo
              : path.startsWith("/settings/")
                ? `${path}${location.search}`
                : "/",
          );
        }}
      />
    );
  if (context.isError && !context.data)
    return (
      <main className="startup-state">
        <h1>Account context could not be loaded</h1>
        <p role="alert">{context.error.message}</p>
        <Button onPress={() => void context.refetch()}>Retry</Button>
        <Button
          variant="secondary"
          onPress={() =>
            void authClient.signOut().then(
              () => location.assign("/login"),
              () => location.assign("/login"),
            )
          }
        >
          Sign in again
        </Button>
      </main>
    );
  if (navigationError)
    return (
      <main className="startup-state">
        <h1>The linked settings could not be opened</h1>
        <p role="alert">{navigationError}</p>
        <Button onPress={() => location.assign("/")}>
          Return to databases
        </Button>
      </main>
    );
  if (!context.data?.organisation)
    return (
      <main className="startup-state">
        <h1>No organisation access</h1>
        <p>
          Your account does not have an organisation membership. Contact an
          administrator or accept an invitation.
        </p>
        <Button
          onPress={() =>
            void authClient.signOut().then(() => location.assign("/login"))
          }
        >
          Sign out
        </Button>
      </main>
    );

  const contextIds = {
    databaseId: selectedDatabaseId,
    tableId: selectedTableId,
  };
  const openSettings = (section: SettingsSection) =>
    router.push(settingsHref(section, contextIds));
  const backToData = () =>
    router.push(
      dataHref(
        selectedDatabaseId,
        settings && settingsScope(settings) === "database"
          ? null
          : selectedTableId,
      ),
    );
  const icon = (value: typeof Database01Icon) => (
    <HugeiconsIcon
      aria-hidden="true"
      icon={value}
      size={16}
      className="size-4 shrink-0"
    />
  );
  const profileName = context.data.profile?.name ?? "Account";
  const secondary = (
    <PageNavigation
      section={settings}
      role={context.data.principal.role}
      database={database}
      table={table}
      databaseId={selectedDatabaseId}
      tableId={selectedTableId}
    />
  );
  const resourceScope =
    !settings || ["database", "table"].includes(settingsScope(settings));
  return (
    <>
      <a href="#table-content" className="skip-link">
        Skip to content
      </a>
      <AppLayout
        className="rootset-application"
        path={`${path}?${parameters.toString()}`}
        navigate={(href) => {
          const section = /^\/settings\/([^/?]+)$/.exec(href)?.[1];
          router.push(
            section && Object.hasOwn(SECTION_LABELS, section)
              ? settingsHref(section as SettingsSection, contextIds)
              : href,
          );
        }}
        sidebarOpen={sidebar.sidebarOpen}
        onSidebarOpenChange={sidebar.onSidebarOpenChange}
        navbar={
          <Navbar
            sidebarOpen={sidebar.sidebarOpen}
            onSidebarToggle={() =>
              sidebar.onSidebarOpenChange(!sidebar.sidebarOpen)
            }
            title={
              settings && !resourceScope ? (
                scopeTitles[settingsScope(settings)]
              ) : (
                <span className="navbar-breadcrumb">
                  <Link href={dataHref(selectedDatabaseId)}>
                    {database?.name ?? "Databases"}
                  </Link>
                  {(table || (!settings && selectedDatabaseId)) && (
                    <>
                      <span aria-hidden="true">/</span>
                      <strong>{table?.name ?? "Tables"}</strong>
                    </>
                  )}
                </span>
              )
            }
            actions={
              <ThemeSwitcher
                size="small"
                theme={resolvedTheme}
                onThemeChange={(theme) => {
                  void client
                    .request("/me/preferences", {
                      method: "PATCH",
                      body: { theme },
                    })
                    .then(refresh)
                    .catch((error: unknown) =>
                      setMutationError(
                        error instanceof Error
                          ? error.message
                          : "Appearance could not be saved.",
                      ),
                    );
                }}
              />
            }
          />
        }
        sidebar={
          <ApplicationSidebar
            config={{
              accessibleLabel: "Primary navigation",
              homeHref: dataHref(selectedDatabaseId),
              brand: {
                title: "Rootset",
                logo: <span className="rootset-symbol">r</span>,
              },
              groups: [
                {
                  id: "databases",
                  header: (
                    <div className="primary-group-heading">
                      <h2>Databases</h2>
                      {canCreateDatabase && (
                        <Button
                          isIconOnly
                          variant="ghost"
                          aria-label="Create database"
                          onPress={() => {
                            setCreate("database");
                            setMutationError(null);
                          }}
                        >
                          {icon(PlusSignIcon)}
                        </Button>
                      )}
                    </div>
                  ),
                  content: databases.isError ? (
                    <p className="error-message" role="alert">
                      {databases.error.message}
                      <Button
                        variant="ghost"
                        onPress={() => void databases.refetch()}
                      >
                        Retry
                      </Button>
                    </p>
                  ) : undefined,
                  items: (databases.data ?? []).map((entry) => ({
                    id: entry.id,
                    label: entry.name,
                    href: dataHref(entry.id),
                    icon: icon(Database01Icon),
                    active: resourceScope && entry.id === selectedDatabaseId,
                  })),
                },
                {
                  id: "settings",
                  label: "Settings",
                  items: [
                    {
                      id: "account",
                      label: "Account settings",
                      href: settingsHref("profile", contextIds),
                      icon: icon(UserAccountIcon),
                      active:
                        !!settings && settingsScope(settings) === "account",
                    },
                    ...(canManage
                      ? [
                          {
                            id: "team",
                            label: "Team settings",
                            href: settingsHref("organisation", contextIds),
                            icon: icon(UserGroupIcon),
                            active:
                              !!settings && settingsScope(settings) === "team",
                          },
                        ]
                      : []),
                  ],
                },
              ],
              footerContent: (
                <FooterIdentity
                  name={profileName}
                  email={context.data.profile?.email ?? ""}
                  roleLabel={
                    context.data.principal.role.charAt(0).toUpperCase() +
                    context.data.principal.role.slice(1)
                  }
                  onLogout={() => {
                    void authClient.signOut().then(() => {
                      queryClient.clear();
                      location.assign("/login");
                    });
                  }}
                >
                  <Dropdown.Section aria-label="Account">
                    <Header className="px-2 py-1.5 text-xs font-medium text-muted">
                      Account
                    </Header>
                    <Dropdown.Item id="profile" textValue="Profile">
                      {icon(UserAccountIcon)}Profile
                    </Dropdown.Item>
                    <Dropdown.Item id="preferences" textValue="Preferences">
                      {icon(Settings01Icon)}Preferences
                    </Dropdown.Item>
                    <Dropdown.Item id="2fa" textValue="Account security">
                      {icon(SecurityCheckIcon)}Account security
                    </Dropdown.Item>
                    <Dropdown.Item id="api-keys" textValue="API keys">
                      {icon(Key01Icon)}API keys
                    </Dropdown.Item>
                  </Dropdown.Section>
                  <Dropdown.Section aria-label="Rootset">
                    <Header className="px-2 py-1.5 text-xs font-medium text-muted">
                      Rootset
                    </Header>
                    <Dropdown.Item
                      id="documentation"
                      textValue="Documentation"
                      href="https://github.com/avgeek-inc/rootset/tree/main/docs"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {icon(BookOpen01Icon)}Documentation
                    </Dropdown.Item>
                  </Dropdown.Section>
                </FooterIdentity>
              ),
            }}
          />
        }
        secondarySidebar={secondary}
      >
        {mutationError && !create && (
          <p className="error-banner" role="alert">
            {mutationError}
          </p>
        )}
        {settings ? (
          <SettingsPanel
            section={settings}
            orgId={orgId!}
            role={context.data.principal.role}
            databaseId={selectedDatabaseId ?? undefined}
            tableId={selectedTableId ?? undefined}
            theme={preferences.theme}
            onClose={backToData}
            onChanged={refresh}
          />
        ) : table && selectedDatabaseId ? (
          <Spreadsheet
            key={table.id}
            orgId={orgId!}
            databaseId={selectedDatabaseId}
            table={table}
            preferences={preferences}
            canEdit={canEdit}
            canManage={canManage}
            onSettings={(section) => openSettings(section as SettingsSection)}
            onChanged={() =>
              void queryClient.invalidateQueries({
                queryKey: ["tables", orgId, selectedDatabaseId],
              })
            }
          />
        ) : selectedDatabaseId && database && !selectedTableId ? (
          <TablesPage
            databaseId={selectedDatabaseId}
            tables={tables.data ?? []}
            pending={tables.isPending}
            error={tables.error?.message ?? ""}
            canCreate={canManage}
            onCreate={() => {
              setCreate("table");
              setMutationError(null);
            }}
            onRetry={() => void tables.refetch()}
          />
        ) : databases.isPending || (selectedDatabaseId && tables.isPending) ? (
          <div className="grid-skeleton" role="status">
            Loading databases and tables…
          </div>
        ) : (
          <section className="empty-state">
            <DatabaseIcon size={32} aria-hidden="true" />
            <h1>
              {canManage
                ? database
                  ? "Create your first table"
                  : "Create your first database"
                : database
                  ? "No tables yet"
                  : "No databases yet"}
            </h1>
            <p>
              {canManage
                ? database
                  ? "Add a structured table, then define its fields."
                  : "Keep related master data together in one database."
                : "An admin can create databases, tables, and fields for this installation."}
            </p>
            {(database ? canManage : canCreateDatabase) && (
              <Button
                onPress={() => setCreate(database ? "table" : "database")}
              >
                {database ? "Create table" : "Create database"}
              </Button>
            )}
          </section>
        )}
      </AppLayout>
      {create && (
        <Dialog
          title={`Create ${create}`}
          onClose={() => {
            if (!pending) setCreate(null);
          }}
        >
          <form className="dialog-form" onSubmit={createResource}>
            <TextField name="name" isRequired>
              <Label>
                {create === "database" ? "Database name" : "Table name"}
              </Label>
              <Input
                autoFocus={
                  typeof window !== "undefined" &&
                  !matchMedia("(pointer: coarse)").matches
                }
                maxLength={255}
              />
            </TextField>
            {mutationError && (
              <p className="error-message" role="alert">
                {mutationError}
              </p>
            )}
            <footer>
              <Button
                variant="secondary"
                isDisabled={pending}
                onPress={() => setCreate(null)}
              >
                Cancel
              </Button>
              <Button type="submit" isDisabled={pending}>
                {pending ? "Creating…" : `Create ${create}`}
              </Button>
            </footer>
          </form>
        </Dialog>
      )}
    </>
  );
}

function ConsentScreen() {
  const requestId =
    typeof location === "undefined"
      ? ""
      : (new URLSearchParams(location.search).get("requestId") ?? "");
  const request = useQuery({
    queryKey: ["oauth-request", requestId],
    queryFn: ({ signal }) =>
      client.request<{
        client: { id: string; name: string; provenance: string; trust: string };
        scopes: string[];
        organizationId: string;
        resource: string;
        expiresAt: string;
      }>(`/oauth/requests/${encodeURIComponent(requestId)}`, { signal }),
    enabled: !!requestId,
  });
  const organisation = useQuery({
    queryKey: ["consent-organisation", request.data?.organizationId],
    queryFn: ({ signal }) =>
      client.request<{ name: string }>(
        `/orgs/${request.data!.organizationId}`,
        { signal },
      ),
    enabled: !!request.data?.organizationId,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [needsProof, setNeedsProof] = useState(false);
  const [proofPassword, setProofPassword] = useState("");
  const [proofCode, setProofCode] = useState("");
  async function decide(approve: boolean) {
    setPending(true);
    setError(null);
    try {
      if (approve && needsProof) {
        await new RootsetClient({ baseUrl: "/v1" }).request(
          "/auth/reauthenticate",
          {
            method: "POST",
            body: {
              password: proofPassword,
              ...(proofCode ? { code: proofCode } : {}),
            },
          },
        );
        setProofPassword("");
        setProofCode("");
      }
      const result = await client.request<{ redirectUri: string }>(
        `/oauth/requests/${encodeURIComponent(requestId)}/decision`,
        { method: "POST", body: { approve } },
      );
      location.assign(result.redirectUri);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Consent failed");
      if (
        failure instanceof ApiError &&
        [
          "STEP_UP_REQUIRED",
          "RECENT_AUTH_REQUIRED",
          "interaction_required",
        ].includes(failure.code)
      )
        setNeedsProof(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="identity-shell">
      <section className="identity-panel">
        <h1>Connect to Rootset</h1>
        {request.isPending ? (
          <p role="status">Loading application request…</p>
        ) : request.isError ? (
          <>
            <p role="alert" className="error-message">
              {request.error.message}
            </p>
            {request.error instanceof ApiError &&
              request.error.status === 401 && (
                <a
                  href={`/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`}
                >
                  Sign in to review this request
                </a>
              )}
          </>
        ) : (
          request.data && (
            <>
              <p>
                <strong>{request.data.client.name}</strong> requests access to{" "}
                <strong>
                  {organisation.data?.name ?? "your organisation"}
                </strong>
                .
              </p>
              <dl>
                <dt>Resource</dt>
                <dd>{request.data.resource}</dd>
                <dt>Client verification</dt>
                <dd>
                  {request.data.client.trust === "operator_registered"
                    ? "Registered by an installation administrator"
                    : "Unverified client. Check this application’s identity before approving."}
                </dd>
                <dt>Client identifier</dt>
                <dd>{request.data.client.id}</dd>
                <dt>Requested permissions</dt>
                <dd>
                  <ul>
                    {request.data.scopes.map((scope) => (
                      <li key={scope}>{scope}</li>
                    ))}
                  </ul>
                </dd>
              </dl>
              <p>
                Request expires{" "}
                {new Date(request.data.expiresAt).toLocaleString()}.
              </p>
              <p>
                Access stays within your current permissions. You can revoke
                this connection in settings.
              </p>
              {error && (
                <p role="alert" className="error-message">
                  {error}
                </p>
              )}
              {needsProof && (
                <div className="identity-form">
                  <TextField
                    value={proofPassword}
                    onChange={setProofPassword}
                    type="password"
                    isRequired
                  >
                    <Label>Current password</Label>
                    <Input autoComplete="current-password" />
                  </TextField>
                  <TextField value={proofCode} onChange={setProofCode}>
                    <Label>Authenticator code (if enabled)</Label>
                    <Input autoComplete="one-time-code" />
                  </TextField>
                  <Button
                    variant="secondary"
                    isDisabled={pending}
                    onPress={() => {
                      setPending(true);
                      void authClient.signIn
                        .passkey()
                        .then((result) => {
                          if (result.error)
                            setError(
                              result.error.message ??
                                "Passkey verification failed",
                            );
                          else {
                            setNeedsProof(false);
                            setProofPassword("");
                            setProofCode("");
                            setError(null);
                          }
                        })
                        .finally(() => setPending(false));
                    }}
                  >
                    Verify with a passkey
                  </Button>
                </div>
              )}
              <div className="action-row">
                <Button
                  variant="secondary"
                  isDisabled={pending}
                  onPress={() => void decide(false)}
                >
                  Deny access
                </Button>
                <Button isDisabled={pending} onPress={() => void decide(true)}>
                  {needsProof ? "Verify and allow access" : "Allow access"}
                </Button>
              </div>
            </>
          )
        )}
      </section>
    </main>
  );
}

function AccountActionApproval({ id }: { id: string }) {
  const request = useQuery({
    queryKey: ["account-action", id],
    queryFn: ({ signal }) =>
      client.request<{
        type: string;
        repairIntent?: OperatorRepairIntent;
        state: string;
        expiresAt: string;
        clientName?: string;
        target?: string;
        display?: {
          operationId: string;
          clientName?: string;
          targetName?: string;
          summary?: string;
        };
        result?: {
          operationId?: string;
          input?: Record<string, unknown>;
          clientId?: string;
        };
      }>(`/me/actions/${encodeURIComponent(id)}`, { signal }),
  });
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [verified, setVerified] = useState(false);
  const [factor, setFactor] = useState<"totp" | "recovery" | null>(null);
  const [pending, setPending] = useState(false);
  const repairUnavailable = repairReviewUnavailable(request.data);
  async function finishReauthentication() {
    const details = await request.refetch();
    if (details.error) throw details.error;
    setFactor(null);
    setVerified(true);
  }
  async function approve() {
    if (
      repairUnavailable ||
      !request.data ||
      request.isPending ||
      request.isError ||
      request.data.state !== "pending"
    ) {
      setError(
        repairUnavailable
          ? repairReviewError
          : "This request is not available for approval.",
      );
      return;
    }
    setPending(true);
    setError(null);
    try {
      await client.request(
        `/account-actions/${encodeURIComponent(id)}/approve`,
        { method: "POST", body: {} },
      );
      setApproved(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Approval failed");
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="identity-shell">
      <section className="identity-panel">
        <h1>Approve account action</h1>
        {request.data && (
          <>
            <p>
              {(request.data.display?.clientName ?? request.data.clientName)
                ? `${request.data.display?.clientName ?? request.data.clientName} requests`
                : "You requested"}{" "}
              <strong>{request.data.type.replaceAll("_", " ")}</strong>
              {(request.data.display?.targetName ?? request.data.target)
                ? ` for ${request.data.display?.targetName ?? request.data.target}`
                : ""}
              .
            </p>
            {request.data.display?.summary && (
              <p>{request.data.display.summary}</p>
            )}
            {request.data.result?.clientId && (
              <p>Requesting client: {request.data.result.clientId}</p>
            )}
            {request.data.type === "operator_repair" &&
              request.data.repairIntent &&
              !repairUnavailable && (
                <RepairIntentReview
                  key={id}
                  intent={request.data.repairIntent}
                />
              )}
            {repairUnavailable && (
              <p role="alert" className="error-message">
                {repairReviewError}
              </p>
            )}
            {request.data.type !== "operator_repair" &&
              request.data.result?.input && (
                <dl className="action-review">
                  {Object.entries(request.data.result.input).map(
                    ([name, value]) => (
                      <div key={name}>
                        <dt>
                          {name.replaceAll(/([A-Z])/g, " $1").toLowerCase()}
                        </dt>
                        <dd>
                          {typeof value === "object" && value !== null ? (
                            <pre>{JSON.stringify(value, null, 2)}</pre>
                          ) : (
                            String(value ?? "null")
                          )}
                        </dd>
                      </div>
                    ),
                  )}
                </dl>
              )}
            <p>Expires {new Date(request.data.expiresAt).toLocaleString()}.</p>
          </>
        )}
        {request.isError && (
          <p className="error-message" role="alert">
            {request.error.message}
          </p>
        )}
        {approved ? (
          <p role="status">
            Approved. Return to the requesting application to complete the
            action.
          </p>
        ) : verified ? (
          <>
            <p>
              Your identity is verified. Approve the action described above to
              let the requesting application complete it.
            </p>
            <Button
              isDisabled={
                pending ||
                request.isPending ||
                request.isError ||
                repairUnavailable ||
                request.data?.state !== "pending"
              }
              onPress={() => void approve()}
            >
              {pending ? "Approving…" : "Approve this action"}
            </Button>
          </>
        ) : factor ? (
          <form
            className="identity-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const code = String(
                new FormData(event.currentTarget).get("code") ?? "",
              );
              setPending(true);
              setError(null);
              try {
                const result =
                  factor === "totp"
                    ? await authClient.twoFactor.verifyTotp({
                        code,
                        trustDevice: false,
                      })
                    : await authClient.twoFactor.verifyBackupCode({
                        code,
                        trustDevice: false,
                      });
                if (result.error) throw new Error(result.error.message);
                await finishReauthentication();
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Factor verification failed",
                );
              } finally {
                setPending(false);
              }
            }}
          >
            <TextField name="code" isRequired>
              <Label>
                {factor === "totp" ? "Authenticator code" : "Recovery code"}
              </Label>
              <Input
                autoComplete="one-time-code"
                inputMode={factor === "totp" ? "numeric" : "text"}
                autoFocus
              />
            </TextField>
            <Button type="submit" isDisabled={pending}>
              Verify identity
            </Button>
            <Button
              variant="secondary"
              onPress={() => setFactor(factor === "totp" ? "recovery" : "totp")}
            >
              {factor === "totp"
                ? "Use a recovery code"
                : "Use an authenticator code"}
            </Button>
          </form>
        ) : (
          <>
            <p>Confirm your identity to approve only this bound request.</p>
            <IdentityCredentialsForm
              onSubmit={async ({ email, password }) => {
                const result = await authClient.signIn.email({
                  email,
                  password,
                });
                if (result.error) throw new Error(result.error.message);
                if (
                  result.data &&
                  "twoFactorRedirect" in result.data &&
                  result.data.twoFactorRedirect
                ) {
                  setFactor("totp");
                  return;
                }
                await finishReauthentication();
              }}
              submitLabel="Verify identity"
            />
            <Button
              variant="secondary"
              onPress={async () => {
                const result = await authClient.signIn.passkey();
                if (result.error) {
                  setError(
                    result.error.message ?? "Passkey verification failed",
                  );
                  return;
                }
                try {
                  await finishReauthentication();
                } catch (failure) {
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : "Approval failed",
                  );
                }
              }}
            >
              Verify with passkey
            </Button>
          </>
        )}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
