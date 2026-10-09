"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Input, Label, TextField } from "@heroui/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Database as DatabaseIcon } from "./ui/icons";
import { DatabasesPage } from "./databases-page";
import { RootsetLogo } from "./rootset-logo";
import { TablesPage } from "./tables-page";
import {
  client,
  ApiError,
  RootsetClient,
  browserApiOrigin,
  resourcePath,
  unwrapData,
} from "@rootset/web-client";
import { AuthPage, AsyncActionButton } from "@avgeek-oss/design-system";
import {
  QueryError,
  QueryLoading,
} from "@avgeek-oss/design-system/patterns/feedback/query-state";
import { AuthFrame } from "./auth-frame";
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
import { EmailChangeConfirmation } from "./email-change-confirmation";
import { ReauthenticationDialog } from "./settings/account/reauthentication-dialog";
import { NotificationCenter } from "./notification-center";
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
  PageNavigation,
} from "./settings/navigation";
import {
  ApplicationSidebar,
  AppLayout,
  AppShell,
  ApplicationNavbar,
  SidebarAccountMenu,
  useTheme,
} from "@avgeek-oss/design-system";
import { AppShellBreadcrumb } from "@avgeek-oss/design-system/layouts/app-shell-breadcrumb";
import { usePersistentAppSidebar } from "@avgeek-oss/design-system/layouts/app-shell";
import { SecondarySidebarLayout } from "@avgeek-oss/design-system/navigation/secondary-sidebar";
import { ThemeSwitcher } from "@avgeek-oss/design-system/controls/theme-switcher";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Database01Icon,
  Logout01Icon,
  Settings01Icon,
  UserAccountIcon,
  UserGroupIcon,
  BookOpen01Icon,
  Key01Icon,
  SecurityCheckIcon,
} from "@hugeicons/core-free-icons";

type Context = z.infer<typeof ContextSchema>;
const publicClient = new RootsetClient({
  baseUrl: () => `${browserApiOrigin()}/v1`,
});
const defaultPreferences = {
  timezone: "UTC",
  locale: "en",
  dateFormat: "day-short-month-year",
  timeFormat: "24-hour",
  theme: "system",
} as const;

export function RootsetApp() {
  const path = usePathname();
  const parameters = useSearchParams();
  const router = useRouter();
  const sidebar = usePersistentAppSidebar("rootset:sidebar-open");
  const { themeMode, isHydrated, setThemeMode } = useTheme();
  const lastServerTheme = useRef<string | null>(null);
  const themeSavePending = useRef(false);
  const [savingTheme, setSavingTheme] = useState(false);
  const queryClient = useQueryClient();
  const browserSession = authClient.useSession();
  const databaseId = parameters.get("databaseId");
  const tableId = parameters.get("tableId");
  const teamSection = path.startsWith("/team-settings/")
    ? path.split("/")[2]
    : null;
  const section =
    teamSection === "general"
      ? "organisation"
      : teamSection === "members"
        ? "members"
        : path.startsWith("/settings/")
          ? path.split("/")[2]
          : null;
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
  const selectedDatabaseId = databaseId ?? null;
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
  const canEdit = canManage || context.data?.principal.role === "member";

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
    const stored = context.data?.preferences?.theme;
    if (!isHydrated || !stored) return;
    if (lastServerTheme.current !== stored) {
      lastServerTheme.current = stored;
      setThemeMode(stored);
      return;
    }
    if (themeMode === stored || themeSavePending.current) return;
    themeSavePending.current = true;
    setSavingTheme(true);
    void client
      .request("/me/preferences", {
        method: "PATCH",
        body: { theme: themeMode },
      })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ["context"] });
      })
      .catch((error: unknown) => {
        setThemeMode(stored);
        toast.danger(
          error instanceof Error
            ? error.message
            : "Appearance could not be saved.",
        );
      })
      .finally(() => {
        themeSavePending.current = false;
        setSavingTheme(false);
      });
  }, [
    context.data?.preferences?.theme,
    themeMode,
    isHydrated,
    setThemeMode,
    queryClient,
  ]);

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

  if (path === "/email-change" || path === "/confirm-email-change")
    return (
      <AuthPage>
        <EmailChangeConfirmation />
      </AuthPage>
    );
  if (setup.isPending || (setup.data?.claimed && context.isPending))
    return <QueryLoading />;
  if (setup.isError)
    return (
      <AuthPage>
        <QueryError
          message={setup.error.message}
          onRetry={() => void setup.refetch()}
        />
      </AuthPage>
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
              : path.startsWith("/settings/") ||
                  path.startsWith("/team-settings/")
                ? `${path}${location.search}${location.hash}`
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
      <AppShell.Root
        policy={{ kind: "product", themeControl: "header", toasts: false }}
        contentWidth="broad"
      >
        <AppLayout
          className="rootset-application"
          navigate={(href) => router.push(href)}
          sidebarOpen={sidebar.sidebarOpen}
          onSidebarOpenChange={sidebar.onSidebarOpenChange}
          navbar={
            <ApplicationNavbar
              config={{
                brand: {
                  id: "rootset",
                  accessibleLabel: "Rootset home",
                  title: "Rootset",
                  logo: <RootsetLogo />,
                },
                homeHref: "/",
              }}
              hasSidebar
              sidebarOpen={sidebar.sidebarOpen}
              onSidebarToggle={() =>
                sidebar.onSidebarOpenChange(!sidebar.sidebarOpen)
              }
              showThemeSwitcher={false}
              actions={
                <>
                  <NotificationCenter
                    key={`${context.data.organisation?.id}:${context.data.principal.id}`}
                  />
                  <ThemeSwitcher isDisabled={savingTheme} />
                </>
              }
            />
          }
          sidebar={
            <ApplicationSidebar
              config={{
                accessibleLabel: "Primary navigation",
                homeHref: "/",
                brand: {
                  id: "rootset",
                  accessibleLabel: "Rootset home",
                  title: "Rootset",
                  logo: <RootsetLogo />,
                },
                groups: [
                  {
                    id: "operate",
                    label: "Operate",
                    items: [
                      {
                        kind: "link",
                        id: "databases",
                        label: "Databases",
                        href: "/databases",
                        icon: Database01Icon,
                        activePath: resourceScope ? path : "/databases",
                      },
                    ],
                  },
                  {
                    id: "settings",
                    label: "Settings",
                    items: [
                      {
                        kind: "link",
                        id: "account",
                        label: "Account Settings",
                        href: settingsHref("profile", {}),
                        icon: UserAccountIcon,
                        activePath:
                          settings && settingsScope(settings) === "account"
                            ? path
                            : "/settings/profile",
                      },
                      ...(canManage
                        ? [
                            {
                              kind: "link" as const,
                              id: "team",
                              label: "Team Settings",
                              href: settingsHref("organisation", {}),
                              icon: UserGroupIcon,
                              activePath:
                                settings && settingsScope(settings) === "team"
                                  ? path
                                  : "/team-settings",
                            },
                          ]
                        : []),
                    ],
                  },
                ],
                footerContent: (
                  <SidebarAccountMenu
                    name={profileName}
                    email={context.data.profile?.email ?? ""}
                    teamName={context.data.organisation?.name ?? "Rootset"}
                    groups={[
                      {
                        id: "account",
                        label: "Account",
                        items: [
                          {
                            id: "profile",
                            label: "Profile",
                            icon: icon(UserAccountIcon),
                          },
                          {
                            id: "preferences",
                            label: "Preferences",
                            icon: icon(Settings01Icon),
                          },
                          {
                            id: "passkeys",
                            label: "Two-factor Auth",
                            icon: icon(SecurityCheckIcon),
                          },
                          {
                            id: "api-keys",
                            label: "API Keys",
                            icon: icon(Key01Icon),
                          },
                        ],
                      },
                      {
                        id: "rootset",
                        label: "Rootset",
                        items: [
                          {
                            id: "documentation",
                            label: "Documentation",
                            icon: icon(BookOpen01Icon),
                          },
                        ],
                      },
                      {
                        id: "session",
                        label: "Session",
                        items: [
                          {
                            id: "logout",
                            label: "Sign out",
                            icon: icon(Logout01Icon),
                            destructive: true,
                          },
                        ],
                      },
                    ]}
                    onAction={(id) => {
                      if (id === "logout")
                        void authClient.signOut().then(() => {
                          queryClient.clear();
                          location.assign("/login");
                        });
                      else if (id === "documentation")
                        window.open(
                          "https://github.com/avgeek-oss/rootset/tree/main/docs",
                          "_blank",
                          "noopener,noreferrer",
                        );
                      else {
                        const section = resolveSettingsSection(id);
                        if (section) openSettings(section);
                      }
                    }}
                  />
                ),
              }}
            />
          }
        >
          <AppShellBreadcrumb
            items={[
              settings && settingsScope(settings) === "account"
                ? { label: "Account Settings", href: "/settings/profile" }
                : settings && settingsScope(settings) === "team"
                  ? { label: "Team Settings", href: "/team-settings/general" }
                  : { label: "Rootset", href: "/" },
              ...(settings
                ? [{ label: SECTION_LABELS[settings] }]
                : [
                    {
                      label: database?.name ?? "Databases",
                      href: dataHref(selectedDatabaseId),
                    },
                    { label: table?.name ?? "Tables" },
                  ].filter((_, index) => selectedDatabaseId || index === 0)),
            ]}
            title={
              settings
                ? SECTION_LABELS[settings]
                : (table?.name ?? (selectedDatabaseId ? "Tables" : "Databases"))
            }
          />
          <div id="table-content" tabIndex={-1} className="rootset-workspace">
            <SecondarySidebarLayout>
              {secondary}
              {mutationError && !create && (
                <p className="error-banner" role="alert">
                  {mutationError}
                </p>
              )}
              {settings ? (
                <AppShell.Content variant="broad">
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
                </AppShell.Content>
              ) : !selectedDatabaseId && !selectedTableId ? (
                <DatabasesPage
                  databases={databases.data ?? []}
                  pending={databases.isPending}
                  error={databases.error?.message ?? ""}
                  canCreate={canCreateDatabase}
                  onCreate={() => {
                    setCreate("database");
                    setMutationError(null);
                  }}
                  onRetry={() => void databases.refetch()}
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
                  onSettings={(section) =>
                    openSettings(section as SettingsSection)
                  }
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
              ) : databases.isPending ||
                (selectedDatabaseId && tables.isPending) ? (
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
            </SecondarySidebarLayout>
          </div>
        </AppLayout>
      </AppShell.Root>
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
  const security = useQuery({
    queryKey: ["consent-security"],
    queryFn: ({ signal }) =>
      client.request<{ twoFactorEnabled: boolean }>("/me/security", { signal }),
    enabled: !!request.data,
  });
  async function decide(approve: boolean, proofVerified = false) {
    setPending(true);
    setError(null);
    try {
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
      if (proofVerified) throw failure;
    } finally {
      setPending(false);
    }
  }
  return (
    <AuthPage>
      <AuthFrame
        title="Connect to Rootset"
        description="Review the application and requested access before connecting."
      >
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
              {security.isError && (
                <p role="alert" className="error-message">
                  {security.error.message}
                </p>
              )}
              <ReauthenticationDialog
                isOpen={needsProof && !!security.data}
                onOpenChange={setNeedsProof}
                hasPasskey={Boolean(security.data?.twoFactorEnabled)}
                onConfirmed={async () => {
                  await decide(true, true);
                  setNeedsProof(false);
                }}
              />
              <div className="action-row">
                <Button
                  variant="secondary"
                  isDisabled={pending}
                  onPress={() => void decide(false)}
                >
                  Deny access
                </Button>
                <Button
                  isDisabled={pending || !security.data}
                  onPress={() => void decide(true)}
                >
                  Allow access
                </Button>
              </div>
            </>
          )
        )}
      </AuthFrame>
    </AuthPage>
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
  const [approved, setApproved] = useState(false);
  const [verified, setVerified] = useState(false);
  const session = authClient.useSession();
  const [proofOpen, setProofOpen] = useState(false);
  const security = useQuery({
    queryKey: ["approval-security", session.data?.user.id],
    queryFn: ({ signal }) =>
      client.request<{ twoFactorEnabled: boolean }>("/me/security", { signal }),
    enabled: Boolean(session.data),
  });
  const [pending, setPending] = useState(false);
  const repairUnavailable = repairReviewUnavailable(request.data);
  async function finishReauthentication() {
    const details = await request.refetch();
    if (details.error) throw details.error;
    setProofOpen(false);
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
      throw new Error(
        repairUnavailable
          ? repairReviewError
          : "This request is not available for approval.",
      );
    }
    setPending(true);
    try {
      await client.request(
        `/account-actions/${encodeURIComponent(id)}/approve`,
        { method: "POST", body: {} },
      );
      setApproved(true);
    } finally {
      setPending(false);
    }
  }
  if (!session.data)
    return (
      <AuthScreen
        path="/login"
        claimed
        onSignedIn={() => void finishReauthentication()}
      />
    );
  return (
    <AuthPage>
      <AuthFrame
        title="Approve account action"
        description="Review the request and confirm your identity."
      >
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
            <AsyncActionButton
              pendingLabel="Approving…"
              isDisabled={
                pending ||
                request.isPending ||
                request.isError ||
                repairUnavailable ||
                request.data?.state !== "pending"
              }
              onAction={approve}
            >
              Approve this action
            </AsyncActionButton>
          </>
        ) : (
          <Button
            isDisabled={
              security.isPending ||
              security.isError ||
              request.isPending ||
              request.isError ||
              repairUnavailable
            }
            onPress={() => setProofOpen(true)}
          >
            Confirm identity
          </Button>
        )}
        <ReauthenticationDialog
          isOpen={proofOpen}
          onOpenChange={setProofOpen}
          hasPasskey={Boolean(security.data?.twoFactorEnabled)}
          onConfirmed={finishReauthentication}
        />
      </AuthFrame>
    </AuthPage>
  );
}
