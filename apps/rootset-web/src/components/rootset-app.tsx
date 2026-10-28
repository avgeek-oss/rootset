"use client";

import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { version as rootsetVersion } from "../../../../package.json";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Input, Label, TextField } from "@heroui/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import {
  PageNavigation as PageTransition,
  usePageQuery,
} from "./page-navigation";
import { DatabasesPage } from "./databases-page";
import { RootsetLogo } from "./rootset-logo";
import { RootsetErrorBoundary, RootsetErrorState } from "./rootset-error-state";
import { TablesPage } from "./tables-page";
import { BreadcrumbResourceSwitcher } from "./breadcrumb-resource-switcher";
import { SpreadsheetLoading } from "./spreadsheet-loading";
import {
  client,
  ApiError,
  RootsetClient,
  browserApiOrigin,
  resourcePath,
  currentWorkspaceId,
  selectWorkspace,
  unwrapData,
} from "@rootset/web-client";
import {
  QueryError,
  QueryLoading,
} from "@avgeek-oss/design-system/patterns/feedback/query-state";
import { AuthPage } from "@avgeek-oss/design-system";
import { ConsentScreen } from "./mcp-oauth-consent";
import {
  ContextSchema,
  IdSchema,
  type Workspace,
  type Database,
  type DatabaseSummary,
  type Table,
  type TableSummary,
} from "@rootset/contracts";
import type { z } from "zod";
import { authClient } from "../lib/auth-client";
import { MutationAttempt } from "../lib/mutation-attempt";
import { Dialog } from "./dialog";
import type { SettingsSection } from "./settings/types";
import { resolveSettingsSection, SECTION_LABELS } from "./settings/types";
import {
  dataHref,
  resourceBreadcrumbs,
  resourceRoute,
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
import { RouteProvider } from "@avgeek-oss/design-system/hooks/route-context";
import { AppShellBreadcrumb } from "@avgeek-oss/design-system/layouts/app-shell-breadcrumb";
import { usePersistentAppSidebar } from "@avgeek-oss/design-system/layouts/app-shell";
import { SecondarySidebarLayout } from "@avgeek-oss/design-system/navigation/secondary-sidebar";
import { ThemeSwitcher } from "@avgeek-oss/design-system/controls/theme-switcher";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  DatabaseIcon,
  Logout03Icon,
  Layers01Icon,
  Settings01Icon,
  UserAccountIcon,
  UserGroupIcon,
  BookOpen01Icon,
  Key01Icon,
  Mail01Icon,
  News01Icon,
  Message01Icon,
} from "@hugeicons/core-free-icons";
import { LogOut, Database as DatabaseSymbol, Plus } from "./ui/icons";

const AuthScreen = lazy(() =>
  import("./auth-screen").then((module) => ({ default: module.AuthScreen })),
);
const EmailChangeConfirmation = lazy(() =>
  import("./email-change-confirmation").then((module) => ({
    default: module.EmailChangeConfirmation,
  })),
);
const Spreadsheet = lazy(() =>
  import("./related-spreadsheet").then((module) => ({
    default: module.RelatedSpreadsheet,
  })),
);
const SettingsPanel = lazy(() =>
  import("./settings").then((module) => ({ default: module.SettingsPanel })),
);
const AuditLogsPage = lazy(() =>
  import("./activity-page").then((module) => ({
    default: module.AuditLogsPage,
  })),
);

import { WorkspaceSwitcher } from "./workspaces";

import { AgentChatTrigger } from "@avgeek-oss/design-system/patterns/agent-chat/agent-chat-trigger";
import { useCommittedWorkspace } from "./workspace-navigation";

const Assistant = lazy(() =>
  import("./assistant").then((module) => ({ default: module.Assistant })),
);

const repositoryUrl = "https://github.com/avgeek-oss/rootset";
const productLinks: Partial<Record<string, string>> = {
  changelog: `${repositoryUrl}/releases`,
  documentation: "https://www.rootset.app/quickstart",
  feedback: `${repositoryUrl}/issues/new`,
};

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
  return (
    <RootsetErrorBoundary>
      <PageTransition location={`${path}?${parameters.toString()}`}>
        {(location) => <RootsetPage location={location} />}
      </PageTransition>
    </RootsetErrorBoundary>
  );
}

function RootsetPage({ location: routeLocation }: { location: string }) {
  const separator = routeLocation.indexOf("?");
  const path = routeLocation.slice(0, separator);
  const parameters = new URLSearchParams(routeLocation.slice(separator + 1));
  const router = useRouter();
  const sidebar = usePersistentAppSidebar("rootset:sidebar-open");
  const { themeMode, isHydrated, setThemeMode } = useTheme();
  const lastServerTheme = useRef<string | null>(null);
  const themeSavePending = useRef(false);
  const [savingTheme, setSavingTheme] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const queryClient = useQueryClient();
  const browserSession = authClient.useSession();
  const route = resourceRoute(path);
  const auditLogsPage =
    path === "/audit-logs" || path === "/workspace-settings/audit-logs";
  const databaseId = auditLogsPage
    ? null
    : (route.databaseId ?? parameters.get("databaseId"));
  const tableId = auditLogsPage
    ? null
    : (route.tableId ?? parameters.get("tableId"));
  const teamSection = path.startsWith("/team-settings/")
    ? path.split("/")[2]
    : null;
  const workspaceSection = path.startsWith("/workspace-settings/")
    ? path.split("/")[2]
    : null;
  const section =
    (auditLogsPage
      ? "workspace-audit-logs"
      : workspaceSection === "delete-workspace"
        ? "workspace-danger-zone"
        : workspaceSection === "general"
          ? "workspace-general"
          : workspaceSection === "manage-access"
            ? "workspace-access"
            : workspaceSection === "api-keys"
              ? "workspace-api-keys"
              : null) ??
    route.section ??
    (teamSection === "general"
      ? "organisation"
      : teamSection === "api-keys"
        ? "workspace-api-keys"
        : teamSection === "workspaces"
          ? "team-workspaces"
          : teamSection === "members"
            ? "members"
            : path.startsWith("/settings/")
              ? path.split("/")[2]
              : null);
  const settings = resolveSettingsSection(section ?? null);
  const needsResources =
    !auditLogsPage &&
    (!settings ||
      !["account", "team", "workspace"].includes(settingsScope(settings)));
  useEffect(() => {
    if (!auditLogsPage && parameters.has("databaseId"))
      router.replace(
        settings
          ? settingsHref(settings, { databaseId, tableId })
          : dataHref(databaseId, tableId),
      );
  }, [parameters, router, settings, databaseId, tableId, auditLogsPage]);
  const [create, setCreate] = useState<"database" | "table" | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const createAttempt = useRef(new MutationAttempt());
  const setup = usePageQuery({
    queryKey: ["setup"],
    queryFn: ({ signal }) =>
      publicClient.request<{ claimed: boolean; verified: boolean }>("/setup", {
        signal,
      }),
    staleTime: 60_000,
  });
  const context = usePageQuery({
    queryKey: ["context"],
    queryFn: ({ signal }) => client.request<Context>("/context", { signal }),
    enabled: setup.data?.claimed === true,
    retry: false,
  });
  const orgId = context.data?.organisation?.id;
  const assistant = usePageQuery({
    queryKey: ["assistant-status", context.data?.principal.userId],
    queryFn: ({ signal }) =>
      client.request<{ enabled: boolean }>("/agent/status", { signal }),
    enabled: !!orgId,
    retry: false,
  });
  const workspaces = usePageQuery({
    queryKey: ["workspaces", orgId],
    queryFn: ({ signal }) =>
      client.operation<{ data: Workspace[] }>(
        "listWorkspaces",
        { orgId },
        { signal },
      ),
    enabled: !!orgId,
  });
  const requestedWorkspaceId =
    parameters.get("workspaceId") ?? currentWorkspaceId();
  const workspace =
    workspaces.data?.data.find((w) => w.id === requestedWorkspaceId) ??
    workspaces.data?.data.find((w) => w.isDefault) ??
    workspaces.data?.data[0];
  // Bootstrap an accessible scope before descendant queries on a direct page load.
  // An existing workspace stays active while a switch prepares its destination.
  if (
    workspace &&
    !workspaces.data?.data.some((w) => w.id === currentWorkspaceId())
  )
    selectWorkspace(workspace.id);
  useCommittedWorkspace(workspace?.id);
  const workspaceSettingsHref = workspace?.isDefault
    ? "/workspace-settings/api-keys"
    : "/workspace-settings/general";
  const databases = usePageQuery({
    queryKey: ["databases", orgId, workspace?.id],
    queryFn: async ({ signal }) =>
      unwrapData(
        await client.request<DatabaseSummary[] | { data: DatabaseSummary[] }>(
          `${resourcePath(orgId!)}/databases?workspaceId=${workspace!.id}`,
          { signal },
        ),
      ),
    enabled: !!orgId && !!workspace && needsResources,
  });
  const selectedDatabaseId = databaseId ?? null;
  const tables = usePageQuery({
    queryKey: ["tables", orgId, selectedDatabaseId, workspace?.id],
    queryFn: async ({ signal }) =>
      unwrapData(
        await client.request<TableSummary[] | { data: TableSummary[] }>(
          `${resourcePath(orgId!, selectedDatabaseId!)}/tables?workspaceId=${workspace!.id}`,
          { signal },
        ),
      ),
    enabled: !!orgId && !!workspace && !!selectedDatabaseId && needsResources,
  });
  const selectedTableId = tableId;
  const database = databases.data?.find(
    (entry) => entry.id === selectedDatabaseId,
  );
  const table = tables.data?.find((entry) => entry.id === selectedTableId);
  const preferences = context.data?.preferences ?? defaultPreferences;
  const canManage = context.data?.principal.role === "admin";
  const canEdit = canManage || context.data?.principal.role === "member";
  const canCreateDatabase = canEdit;

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
          <LogOut />
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
        onSetupComplete={() => {
          queryClient.setQueryData(["setup"], {
            claimed: true,
            verified: true,
          });
          router.replace("/login");
        }}
        onSignedIn={() => {
          queryClient.removeQueries({ queryKey: ["context"] });
          const returnTo = new URLSearchParams(location.search).get("returnTo");
          location.assign(
            returnTo?.startsWith("/") && !returnTo.startsWith("//")
              ? returnTo
              : path.startsWith("/settings/") ||
                  path.startsWith("/team-settings/") ||
                  path.startsWith("/workspace-settings/")
                ? `${path}${location.search}${location.hash}`
                : "/",
          );
        }}
      />
    );
  if (context.isError && !context.data)
    return (
      <RootsetErrorState code={500} onRetry={() => void context.refetch()} />
    );
  if (
    !selectedDatabaseId &&
    !settings &&
    !["/", "/databases", "/audit-logs"].includes(path)
  )
    return <RootsetErrorState code={404} />;
  if (navigationError)
    return (
      <main className="startup-state">
        <h1>The linked settings could not be opened</h1>
        <p role="alert">{navigationError}</p>
        <Button onPress={() => location.assign("/")}>
          <DatabaseSymbol />
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
          <LogOut />
          Sign out
        </Button>
      </main>
    );

  if (orgId && !workspace)
    return workspaces.isError ? (
      <RootsetErrorState code={500} onRetry={() => void workspaces.refetch()} />
    ) : (
      <QueryLoading />
    );
  if (settings && settingsScope(settings) === "workspace" && !canManage)
    return <RootsetErrorState code={404} />;
  if (auditLogsPage && !canManage) return <RootsetErrorState code={404} />;

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
        settings &&
          (settingsScope(settings) === "database" ||
            settings === "table-danger-zone")
          ? null
          : selectedTableId,
      ),
    );
  const icon = (value: typeof DatabaseIcon) => (
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
      locale={preferences.locale}
      workspaceIsDefault={workspace?.isDefault}
    />
  );
  const resourceScope =
    !auditLogsPage &&
    (!settings || ["database", "table"].includes(settingsScope(settings)));
  return (
    <RouteProvider pathname={path} navigate={(href) => router.push(href)}>
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
          {...(assistant.data?.enabled && workspace
            ? {
                aside: (
                  <Suspense
                    fallback={<span role="status">Loading assistant…</span>}
                  >
                    <Assistant
                      key={`${context.data?.principal.userId}:${context.data?.principal.role}:${workspace.id}`}
                      workspaceId={workspace.id}
                      workspaceName={workspace.name}
                      entityNames={Object.fromEntries(
                        [...(databases.data ?? []), ...(tables.data ?? [])].map(
                          (item) => [item.id, item.name],
                        ),
                      )}
                      onClose={() => setAssistantOpen(false)}
                    />
                  </Suspense>
                ),
                asideOpen: assistantOpen,
                onAsideOpenChange: setAssistantOpen,
              }
            : {})}
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
                <div className="flex items-center gap-2">
                  {assistant.data?.enabled && (
                    <AgentChatTrigger
                      isOpen={assistantOpen}
                      onOpenChange={setAssistantOpen}
                    />
                  )}
                  <ThemeSwitcher
                    className="size-8 min-h-8 min-w-8 p-0 text-muted"
                    isDisabled={savingTheme}
                  />
                </div>
              }
            />
          }
          sidebar={
            <ApplicationSidebar
              config={{
                accessibleLabel: "Primary navigation",
                workspace: workspace ? (
                  <WorkspaceSwitcher
                    orgId={orgId!}
                    current={workspace}
                    workspaces={workspaces.data?.data ?? []}
                    canCreate={canManage}
                  />
                ) : undefined,
                homeHref: "/",
                brandVersion: rootsetVersion,
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
                        icon: DatabaseIcon,
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
                              id: "workspace-settings",
                              label: "Workspace Settings",
                              href: workspaceSettingsHref,
                              icon: Layers01Icon,
                              activePath:
                                settings &&
                                settingsScope(settings) === "workspace"
                                  ? path
                                  : workspaceSettingsHref,
                            },
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
                            id: "email-password",
                            label: "Email & Password",
                            icon: icon(Mail01Icon),
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
                            id: "changelog",
                            label: "Changelog",
                            icon: icon(News01Icon),
                          },
                          {
                            id: "documentation",
                            label: "Documentation",
                            icon: icon(BookOpen01Icon),
                          },
                          {
                            id: "feedback",
                            label: "Leave Feedback",
                            icon: icon(Message01Icon),
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
                            icon: icon(Logout03Icon),
                            destructive: true,
                          },
                        ],
                      },
                    ]}
                    onAction={(id) => {
                      const productUrl = productLinks[id];
                      if (id === "logout")
                        void authClient.signOut().then(() => {
                          queryClient.clear();
                          location.assign("/login");
                        });
                      else if (productUrl)
                        window.open(
                          productUrl,
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
            items={
              auditLogsPage
                ? [
                    {
                      label: "Workspace Settings",
                      href: workspaceSettingsHref,
                    },
                    { label: "Audit Logs" },
                  ]
                : resourceBreadcrumbs({
                    workspaceIsDefault: workspace?.isDefault,
                    databaseId: selectedDatabaseId,
                    databaseName: database?.name,
                    tableId: selectedTableId,
                    tableName: table?.name,
                    section: settings,
                    databaseSwitcher: database ? (
                      <BreadcrumbResourceSwitcher
                        kind="database"
                        currentId={database.id}
                        label={database.name}
                        resources={databases.data ?? []}
                      />
                    ) : undefined,
                    tableSwitcher:
                      table && selectedDatabaseId ? (
                        <BreadcrumbResourceSwitcher
                          kind="table"
                          currentId={table.id}
                          databaseId={selectedDatabaseId}
                          label={table.name}
                          resources={tables.data ?? []}
                        />
                      ) : undefined,
                  })
            }
            title={
              auditLogsPage
                ? "Audit Logs"
                : settings
                  ? SECTION_LABELS[settings]
                  : (table?.name ??
                    (selectedDatabaseId ? "Tables" : "Databases"))
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
              {auditLogsPage ? (
                <AuditLogsPage
                  key={`${orgId}:${workspace?.id}:${context.data.principal.role}`}
                  orgId={orgId!}
                  workspaceId={workspace?.id}
                />
              ) : settings ? (
                <AppShell.Content variant="broad">
                  <SettingsPanel
                    section={settings}
                    orgId={orgId!}
                    workspaceId={workspace?.id}
                    workspaceIsDefault={workspace?.isDefault}
                    userId={context.data.principal.userId}
                    role={context.data.principal.role}
                    databaseId={selectedDatabaseId ?? undefined}
                    tableId={selectedTableId ?? undefined}
                    theme={preferences.theme}
                    preferences={preferences}
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
                  key={JSON.stringify([
                    table.id,
                    parameters.get("filter"),
                    parameters.get("view"),
                    parameters.get("relationship"),
                    parameters.get("record"),
                    parameters.get("row"),
                  ])}
                  orgId={orgId!}
                  databaseId={selectedDatabaseId}
                  table={table}
                  preferences={preferences}
                  canEdit={canEdit}
                  canManage={canEdit}
                  relationshipId={parameters.get("relationship")}
                  referencedRowId={parameters.get("record")}
                  linkedFilter={parameters.get("filter")}
                  savedViewId={parameters.get("view")}
                  initialRecordId={parameters.get("row")}
                  onSettings={(section) =>
                    openSettings(section as SettingsSection)
                  }
                  onChanged={() => {
                    void queryClient.invalidateQueries({
                      queryKey: [
                        "tables",
                        orgId,
                        selectedDatabaseId,
                        workspace?.id,
                      ],
                    });
                    void queryClient.invalidateQueries({
                      queryKey: ["databases", orgId, workspace?.id],
                    });
                  }}
                />
              ) : selectedDatabaseId && database && !selectedTableId ? (
                <TablesPage
                  databaseId={selectedDatabaseId}
                  tables={tables.data ?? []}
                  pending={tables.isPending}
                  error={tables.error?.message ?? ""}
                  canCreate={canEdit}
                  onCreate={() => {
                    setCreate("table");
                    setMutationError(null);
                  }}
                  onRetry={() => void tables.refetch()}
                />
              ) : databases.isPending ||
                (selectedDatabaseId && tables.isPending) ? (
                <SpreadsheetLoading />
              ) : (
                <RootsetErrorState code={404} />
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
          <form
            className="dialog-form"
            onSubmit={(event) => {
              // createResource reports its own errors in the dialog.
              void createResource(event);
            }}
          >
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
                <Plus />
                {pending ? "Creating…" : `Create ${create}`}
              </Button>
            </footer>
          </form>
        </Dialog>
      )}
    </RouteProvider>
  );
}
