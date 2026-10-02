"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import {
  Database as DatabaseIcon,
  Table2,
  Plus,
  Settings,
  LogOut,
  PanelLeft,
  ChevronDown,
  CircleHelp,
} from "lucide-react";
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
import { SECTION_LABELS } from "./settings/types";

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
}

export function RootsetApp() {
  const path = usePathname();
  const queryClient = useQueryClient();
  const browserSession = authClient.useSession();
  const [databaseId, setDatabaseId] = useState<string | null>(null);
  const [tableId, setTableId] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [create, setCreate] = useState<"database" | "table" | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [orgSwitcher, setOrgSwitcher] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [navigationPending, setNavigationPending] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const navigated = useRef("");
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
  const selectedTableId = tableId ?? tables.data?.[0]?.id ?? null;
  const database = databases.data?.find(
    (entry) => entry.id === selectedDatabaseId,
  );
  const table = tables.data?.find((entry) => entry.id === selectedTableId);
  const preferences = context.data?.preferences ?? defaultPreferences;
  const canManage =
    context.data?.principal.role === "owner" ||
    context.data?.principal.role === "admin";
  const canCreateDatabase =
    canManage ||
    (context.data?.principal.role === "editor" &&
      context.data.scopes.includes("databases:manage") &&
      context.data.targets.some(
        (target) =>
          target.level === "manage" && !target.databaseId && !target.tableId,
      ));
  const canEdit = canManage || context.data?.principal.role === "editor";

  useEffect(() => {
    const sessionWithoutOrganisation =
      browserSession.data &&
      context.error instanceof ApiError &&
      context.error.status === 401;
    if (
      (!context.data && !sessionWithoutOrganisation) ||
      !path.startsWith("/settings/")
    )
      return;
    const section = path.split("/")[2];
    if (!section || !Object.hasOwn(SECTION_LABELS, section)) return;
    const destination = `${path}${location.search}`;
    if (navigated.current === destination) return;
    navigated.current = destination;
    const parameters = new URLSearchParams(location.search);
    const requestedOrganisation =
      parameters.get("organisationId") ?? parameters.get("orgId");
    const requestedDatabase = parameters.get("databaseId");
    const requestedTable = parameters.get("tableId");
    if (
      [requestedOrganisation, requestedDatabase, requestedTable].some(
        (value) => value && !IdSchema.safeParse(value).success,
      )
    ) {
      setNavigationError(
        "This settings link contains an invalid resource identifier.",
      );
      return;
    }
    setNavigationPending(true);
    setNavigationError(null);
    void (async () => {
      if (requestedOrganisation && requestedOrganisation !== orgId) {
        await publicClient.request("/auth/organisation", {
          method: "POST",
          body: { orgId: requestedOrganisation },
        });
        queryClient.clear();
        const refreshed = await context.refetch();
        if (refreshed.error) throw refreshed.error;
        if (refreshed.data?.organisation?.id !== requestedOrganisation)
          throw new Error("The requested organisation could not be selected.");
      }
      setDatabaseId(requestedDatabase);
      setTableId(requestedTable);
      setSettings(section as SettingsSection);
      setMobileNav(false);
    })()
      .catch((failure) =>
        setNavigationError(
          failure instanceof Error
            ? failure.message
            : "The linked settings could not be opened.",
        ),
      )
      .finally(() => setNavigationPending(false));
  }, [
    path,
    orgId,
    context.data,
    context.error,
    browserSession.data,
    queryClient,
  ]);

  useEffect(() => {
    applyTheme(preferences.theme);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const listener = () => {
      if (preferences.theme === "system") applyTheme("system");
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
        setDatabaseId(item.id);
        setTableId(null);
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
        setTableId(item.table.id);
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

  if (
    setup.isPending ||
    navigationPending ||
    (setup.data?.claimed && context.isPending)
  )
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
      <OrganisationChooser
        onSelected={() => {
          setDatabaseId(null);
          setTableId(null);
          queryClient.removeQueries({ queryKey: ["context"] });
          void context.refetch();
        }}
      />
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
          Your account does not have an active organisation membership. Contact
          an administrator or accept an invitation.
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

  return (
    <div className="rootset-shell">
      <a href="#table-content" className="skip-link">
        Skip to table
      </a>
      <aside
        className={`main-sidebar ${mobileNav ? "mobile-open" : ""}`}
        aria-label="Databases"
      >
        <a className="brand" href="/" aria-label="Rootset home">
          <span className="rootset-symbol" aria-hidden="true">
            r
          </span>
          <strong>Rootset</strong>
        </a>
        <button
          className="org-switch"
          onClick={() => setOrgSwitcher(true)}
          aria-label={`Switch organisation from ${context.data.organisation.name}`}
        >
          <span>{context.data.organisation.name}</span>
          <ChevronDown size={15} />
        </button>
        <div className="sidebar-heading">
          <span>Databases</span>
          {canCreateDatabase && (
            <button
              className="icon-button"
              onClick={() => {
                setCreate("database");
                setMutationError(null);
              }}
              aria-label="Create database"
            >
              <Plus size={17} />
            </button>
          )}
        </div>
        <nav className="database-list" aria-label="Database navigation">
          {databases.data?.map((entry) => (
            <button
              key={entry.id}
              className={`nav-item ${entry.id === selectedDatabaseId ? "selected" : ""}`}
              onClick={() => {
                setDatabaseId(entry.id);
                setTableId(null);
                setMobileNav(false);
              }}
              aria-current={
                entry.id === selectedDatabaseId ? "page" : undefined
              }
            >
              <DatabaseIcon size={17} />
              <span>{entry.name}</span>
            </button>
          ))}
          {databases.isError && (
            <p className="error-message" role="alert">
              {databases.error.message}
              <button onClick={() => void databases.refetch()}>Retry</button>
            </p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setSettings("profile")}>
            <Settings size={17} />
            <span>Settings</span>
          </button>
          <a
            className="nav-item"
            href="https://github.com/avgeek-inc/rootset"
            target="_blank"
            rel="noreferrer"
          >
            <CircleHelp size={17} />
            <span>Documentation</span>
          </a>
          <button
            className="profile-button"
            onClick={() => setSettings("profile")}
          >
            <span className="avatar" aria-hidden="true">
              {context.data.profile?.name.slice(0, 1).toUpperCase() ?? "R"}
            </span>
            <span>
              <strong>{context.data.profile?.name ?? "Account"}</strong>
              <small>{context.data.principal.role}</small>
            </span>
          </button>
          <button
            className="nav-item"
            onClick={() =>
              void authClient.signOut().then(() => {
                queryClient.clear();
                location.assign("/login");
              })
            }
          >
            <LogOut size={16} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>
      <aside className="table-sidebar" aria-label="Tables">
        <header>
          <button
            className="icon-button mobile-toggle"
            aria-label="Open databases"
            onClick={() => setMobileNav(!mobileNav)}
          >
            <PanelLeft size={18} />
          </button>
          <h2>{database?.name ?? "Tables"}</h2>
          {canManage && selectedDatabaseId && (
            <button
              className="icon-button"
              aria-label="Database settings"
              onClick={() => setSettings("database")}
            >
              <Settings size={16} />
            </button>
          )}
        </header>
        <div className="sidebar-heading">
          <span>Tables</span>
          {canEdit && selectedDatabaseId && (
            <button
              className="icon-button"
              aria-label="Create table"
              onClick={() => {
                setCreate("table");
                setMutationError(null);
              }}
            >
              <Plus size={17} />
            </button>
          )}
        </div>
        <nav aria-label="Table navigation">
          {tables.data?.map((entry) => (
            <button
              key={entry.id}
              className={`nav-item ${entry.id === selectedTableId ? "selected" : ""}`}
              onClick={() => {
                setTableId(entry.id);
                setSettings(null);
              }}
              aria-current={entry.id === selectedTableId ? "page" : undefined}
            >
              <Table2 size={17} />
              <span>{entry.name}</span>
              {entry.state !== "active" && <small>{entry.state}</small>}
            </button>
          ))}
          {tables.isError && (
            <p className="error-message" role="alert">
              {tables.error.message}
            </p>
          )}
        </nav>
        <div className="sidebar-bottom">
          {selectedDatabaseId && (
            <button className="nav-item" onClick={() => setSettings("backups")}>
              <DatabaseIcon size={16} />
              <span>Backups</span>
            </button>
          )}
          <button className="nav-item" onClick={() => setSettings("jobs")}>
            <span>Background jobs</span>
          </button>
        </div>
      </aside>
      <main id="table-content" className="content-pane" tabIndex={-1}>
        {settings ? (
          <SettingsPanel
            section={settings}
            orgId={orgId!}
            databaseId={selectedDatabaseId ?? undefined}
            tableId={selectedTableId ?? undefined}
            onClose={() => setSettings(null)}
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
            onSettings={(section) => setSettings(section as SettingsSection)}
            onChanged={() =>
              void queryClient.invalidateQueries({
                queryKey: ["tables", orgId, selectedDatabaseId],
              })
            }
          />
        ) : (
          <section className="empty-state">
            <DatabaseIcon size={32} aria-hidden="true" />
            <h1>
              {database
                ? "Create your first table"
                : "Create your first database"}
            </h1>
            <p>
              {database
                ? "Add a structured table, then define its fields."
                : "Keep related master data together in one database."}
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
      </main>
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
              <Input autoFocus maxLength={255} />
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
      {orgSwitcher && (
        <Dialog
          title="Switch organisation"
          onClose={() => setOrgSwitcher(false)}
        >
          <OrganisationChooser
            embedded
            onSelected={() => {
              setOrgSwitcher(false);
              setDatabaseId(null);
              setTableId(null);
              setSettings(null);
              queryClient.clear();
              void context.refetch();
            }}
          />
          <Button
            variant="secondary"
            onPress={() => {
              setOrgSwitcher(false);
              setSettings("organisation");
            }}
          >
            Organisation settings
          </Button>
        </Dialog>
      )}
    </div>
  );
}

function OrganisationChooser({
  onSelected,
  embedded = false,
}: {
  onSelected: () => void;
  embedded?: boolean;
}) {
  const organisations = useQuery({
    queryKey: ["session-organisations"],
    queryFn: ({ signal }) =>
      publicClient.request<{
        data: { id: string; name: string; role: string }[];
      }>("/auth/organisations", { signal }),
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const content = (
    <>
      <h1>{embedded ? "Your organisations" : "Choose an organisation"}</h1>
      <p>
        Continue with an active membership. Resource permissions apply within
        the selected organisation.
      </p>
      {organisations.isPending ? (
        <p role="status">Loading memberships…</p>
      ) : organisations.isError ? (
        <p role="alert" className="error-message">
          {organisations.error.message}
        </p>
      ) : organisations.data.data.length ? (
        <ul className="organisation-choices">
          {organisations.data.data.map((organisation) => (
            <li key={organisation.id}>
              <Button
                variant="secondary"
                isDisabled={pending}
                onPress={async () => {
                  setPending(true);
                  setError(null);
                  try {
                    await publicClient.request("/auth/organisation", {
                      method: "POST",
                      body: { orgId: organisation.id },
                    });
                    onSelected();
                  } catch (failure) {
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : "Organisation selection failed",
                    );
                  } finally {
                    setPending(false);
                  }
                }}
              >
                {organisation.name}
                <small>{organisation.role}</small>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          No active membership is available. Accept an invitation or contact an
          administrator.
        </p>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {!embedded && (
        <Button
          variant="secondary"
          onPress={() =>
            void authClient.signOut().then(() => location.assign("/login"))
          }
        >
          Sign out
        </Button>
      )}
    </>
  );
  return embedded ? (
    <section className="organisation-selector">{content}</section>
  ) : (
    <main className="identity-shell">
      <section className="identity-panel">{content}</section>
    </main>
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
        targets: { databaseId?: string; tableId?: string; level: string }[];
        unrestricted: boolean;
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
                    ? "Registered by this installation’s operator"
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
                {request.data.unrestricted
                  ? "Access covers resources your current account can use within the requested permissions."
                  : `Access is restricted to ${request.data.targets.length} selected database/table targets.`}
              </p>
              {!request.data.unrestricted && (
                <ul className="consent-targets">
                  {request.data.targets.map((target, index) => (
                    <li key={index}>
                      {target.databaseId && (
                        <>
                          Database: <code>{target.databaseId}</code>.{" "}
                        </>
                      )}
                      {target.tableId && (
                        <>
                          Table: <code>{target.tableId}</code>.{" "}
                        </>
                      )}
                      Access: {target.level}.
                    </li>
                  ))}
                </ul>
              )}
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
