"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Input, Label, TextField } from "@heroui/react";
import { Button } from "@avgeek-oss/design-system/buttons/button";
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
import {
  QueryError,
  QueryLoading,
} from "@avgeek-oss/design-system/patterns/feedback/query-state";
import { AuthPage } from "@avgeek-oss/design-system";
import { ConsentScreen } from "./mcp-oauth-consent";
import {
  ContextSchema,
  IdSchema,
  type Database,
  type DatabaseSummary,
  type Table,
} from "@rootset/contracts";
import type { z } from "zod";
import { authClient } from "../lib/auth-client";
import { MutationAttempt } from "../lib/mutation-attempt";
import { Dialog } from "./dialog";
import type { SettingsSection } from "./settings/types";
import { resolveSettingsSection, SECTION_LABELS } from "./settings/types";
import {
  dataHref,
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
  Settings01Icon,
  UserAccountIcon,
  UserGroupIcon,
  BookOpen01Icon,
  Key01Icon,
  Mail01Icon,
  News01Icon,
  GithubIcon,
  Message01Icon,
} from "@hugeicons/core-free-icons";

const AuthScreen = dynamic(() =>
  import("./auth-screen").then((module) => module.AuthScreen),
);
const EmailChangeConfirmation = dynamic(() =>
  import("./email-change-confirmation").then(
    (module) => module.EmailChangeConfirmation,
  ),
);
const Spreadsheet = dynamic(() =>
  import("./spreadsheet").then((module) => module.Spreadsheet),
);
const SettingsPanel = dynamic(() =>
  import("./settings").then((module) => module.SettingsPanel),
);

const repositoryUrl = "https://github.com/avgeek-oss/rootset";
const productLinks: Partial<Record<string, string>> = {
  changelog: `${repositoryUrl}/releases`,
  documentation: "https://www.rootset.app/quickstart",
  repository: repositoryUrl,
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
  const router = useRouter();
  const sidebar = usePersistentAppSidebar("rootset:sidebar-open");
  const { themeMode, isHydrated, setThemeMode } = useTheme();
  const lastServerTheme = useRef<string | null>(null);
  const themeSavePending = useRef(false);
  const [savingTheme, setSavingTheme] = useState(false);
  const queryClient = useQueryClient();
  const browserSession = authClient.useSession();
  const route = resourceRoute(path);
  const databaseId = route.databaseId ?? parameters.get("databaseId");
  const tableId = route.tableId ?? parameters.get("tableId");
  const teamSection = path.startsWith("/team-settings/")
    ? path.split("/")[2]
    : null;
  const section =
    route.section ??
    (teamSection === "general"
      ? "organisation"
      : teamSection === "api-keys"
        ? "team-api-keys"
        : teamSection === "members"
          ? "members"
          : path.startsWith("/settings/")
            ? path.split("/")[2]
            : null);
  const settings = resolveSettingsSection(section ?? null);
  const needsResources =
    !settings || !["account", "team"].includes(settingsScope(settings));
  useEffect(() => {
    if (parameters.has("databaseId"))
      router.replace(
        settings
          ? settingsHref(settings, { databaseId, tableId })
          : dataHref(databaseId, tableId),
      );
  }, [parameters, router, settings, databaseId, tableId]);
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
        await client.request<DatabaseSummary[] | { data: DatabaseSummary[] }>(
          `${resourcePath(orgId!)}/databases`,
          { signal },
        ),
      ),
    enabled: !!orgId && needsResources,
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
    enabled: !!orgId && !!selectedDatabaseId && needsResources,
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
    />
  );
  const resourceScope =
    !settings || ["database", "table"].includes(settingsScope(settings));
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
                            label: "Auth & Security",
                            icon: icon(Mail01Icon),
                          },
                          {
                            id: "api-keys",
                            label: "My API Keys",
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
                            id: "repository",
                            label: "Repo / Contribute",
                            icon: icon(GithubIcon),
                          },
                          {
                            id: "feedback",
                            label: "Feedback",
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
            items={[
              settings && settingsScope(settings) === "account"
                ? { label: "Account Settings", href: "/settings/profile" }
                : settings && settingsScope(settings) === "team"
                  ? { label: "Team Settings", href: "/team-settings/general" }
                  : { label: "Rootset", href: "/" },
              ...(settings
                ? [
                    ...(selectedDatabaseId
                      ? [
                          {
                            label: database?.name ?? "Database",
                            href: dataHref(selectedDatabaseId),
                          },
                        ]
                      : []),
                    ...(selectedTableId
                      ? [
                          {
                            label: table?.name ?? "Table",
                            href: dataHref(selectedDatabaseId, selectedTableId),
                          },
                        ]
                      : []),
                    { label: SECTION_LABELS[settings] },
                  ]
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
                  key={table.id}
                  orgId={orgId!}
                  databaseId={selectedDatabaseId}
                  table={table}
                  preferences={preferences}
                  canEdit={canEdit}
                  canManage={canEdit}
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
                  canCreate={canEdit}
                  onCreate={() => {
                    setCreate("table");
                    setMutationError(null);
                  }}
                  onRetry={() => void tables.refetch()}
                />
              ) : databases.isPending ||
                (selectedDatabaseId && tables.isPending) ? (
                <div className="grid-skeleton" role="status"></div>
              ) : (
                <section className="empty-state">
                  <HugeiconsIcon
                    icon={DatabaseIcon}
                    size={32}
                    aria-hidden="true"
                  />
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
                      : "An editor or administrator can create databases, tables, and fields for this installation."}
                  </p>
                  {(database ? canEdit : canCreateDatabase) && (
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
    </RouteProvider>
  );
}
