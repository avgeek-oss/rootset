"use client";

// Adapted from the Apache-2.0 Towbar and Mill web design systems.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Drawer, Dropdown } from "@heroui/react";
import { Avatar } from "./avatar";
import {
  Logout03Icon,
  Menu01Icon,
  Moon02Icon,
  SecurityCheckIcon,
  Sun03Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "./button";
import { cn } from "./utils";

export type ContentWidth = "small" | "compact" | "relaxed" | "broad" | "full";
const widths: Record<ContentWidth, string> = {
  small: "max-w-3xl",
  compact: "max-w-5xl",
  relaxed: "max-w-6xl",
  broad: "max-w-7xl",
  full: "max-w-none",
};
const ContentWidthContext = createContext<ContentWidth>("relaxed");

function Root({
  children,
  contentWidth = "relaxed",
  className,
  ...props
}: ComponentProps<"div"> & { contentWidth?: ContentWidth }) {
  return (
    <ContentWidthContext.Provider value={contentWidth}>
      <div className={cn("min-h-dvh", className)} {...props}>
        {children}
      </div>
    </ContentWidthContext.Provider>
  );
}

function Content({
  className,
  variant,
  ...props
}: ComponentProps<"div"> & { variant?: ContentWidth }) {
  const contentWidth = useContext(ContentWidthContext);
  return (
    <div
      className={cn(
        "mx-auto min-h-full w-full min-w-0 px-4 py-3 sm:py-6",
        widths[variant ?? contentWidth],
        className,
      )}
      {...props}
    />
  );
}

export const AppShell = Object.assign(Root, { Content, Root });

const desktopQuery = "(min-width: 64rem)";
const subscribeToViewport = (callback: () => void) => {
  const query = window.matchMedia(desktopQuery);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
};
const isDesktopViewport = () =>
  typeof window !== "undefined" && window.matchMedia(desktopQuery).matches;
const serverViewport = () => false;

const NavigationContext = createContext<{
  path: string;
  navigate: (href: string) => void;
  close: () => void;
  sidebarOpen: boolean;
  focusNavigationToggle: () => void;
}>({
  path: "/",
  navigate: () => {},
  close: () => {},
  sidebarOpen: true,
  focusNavigationToggle: () => {},
});

export function usePersistentAppSidebar(storageKey = "rootset:sidebar-open") {
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (!isDesktopViewport()) return false;
    try {
      return localStorage.getItem(storageKey) !== "false";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    const query = window.matchMedia(desktopQuery);
    const restore = () => {
      let open = query.matches;
      try {
        if (open) open = localStorage.getItem(storageKey) !== "false";
      } catch {
        open = query.matches;
      }
      setSidebarOpen(open);
    };
    restore();
    query.addEventListener("change", restore);
    return () => query.removeEventListener("change", restore);
  }, [storageKey]);
  const onSidebarOpenChange = useCallback(
    (open: boolean) => {
      setSidebarOpen(open);
      if (isDesktopViewport()) {
        try {
          localStorage.setItem(storageKey, String(open));
        } catch {
          // Navigation stays available when browser storage is unavailable.
        }
      }
    },
    [storageKey],
  );
  return { sidebarOpen, onSidebarOpenChange };
}

export type AppLayoutProps = {
  children: ReactNode;
  className?: string;
  navbar: ReactNode;
  navigate: (href: string) => void;
  onSidebarOpenChange: (open: boolean) => void;
  path: string;
  sidebar: ReactNode;
  secondarySidebar?: ReactNode;
  sidebarOpen: boolean;
  toggleShortcut?: boolean;
};

export function AppLayout({
  children,
  className,
  navbar,
  navigate,
  onSidebarOpenChange,
  path,
  sidebar,
  secondarySidebar,
  sidebarOpen,
  toggleShortcut = false,
}: AppLayoutProps) {
  const previousPath = useRef(path);
  const layout = useRef<HTMLDivElement>(null);
  const desktopSidebar = useRef<HTMLElement>(null);
  const isDesktop = useSyncExternalStore(
    subscribeToViewport,
    isDesktopViewport,
    serverViewport,
  );
  const focusNavigationToggle = useCallback(() => {
    layout.current
      ?.querySelector<HTMLButtonElement>(".navigation-toggle")
      ?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (
      isDesktop &&
      !sidebarOpen &&
      desktopSidebar.current?.contains(document.activeElement)
    ) {
      focusNavigationToggle();
    }
  }, [focusNavigationToggle, isDesktop, sidebarOpen]);

  useEffect(() => {
    const routeChanged = previousPath.current !== path;
    previousPath.current = path;
    if (routeChanged && !isDesktopViewport()) onSidebarOpenChange(false);
  }, [onSidebarOpenChange, path]);

  useEffect(() => {
    if (!toggleShortcut) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "b" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onSidebarOpenChange(!sidebarOpen);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onSidebarOpenChange, sidebarOpen, toggleShortcut]);

  return (
    <NavigationContext.Provider
      value={{
        path,
        navigate,
        sidebarOpen,
        focusNavigationToggle,
        close: () => {
          if (!isDesktop) onSidebarOpenChange(false);
        },
      }}
    >
      <div
        ref={layout}
        className={cn("application-layout min-h-dvh", className)}
        data-sidebar-open={sidebarOpen}
      >
        {isDesktop ? (
          <div className="application-sidebar sticky top-0 h-dvh min-w-0 overflow-hidden">
            <aside
              ref={desktopSidebar}
              id="application-navigation"
              aria-hidden={!sidebarOpen}
              inert={!sidebarOpen}
              className="application-sidebar-panel h-full w-60 overflow-hidden border-r border-separator bg-background"
            >
              {sidebar}
            </aside>
          </div>
        ) : null}
        <div className="grid min-h-dvh min-w-0 grid-cols-1 grid-rows-[auto_1fr]">
          {navbar}
          <main
            id="table-content"
            className={cn(
              "min-w-0",
              secondarySidebar && "lg:grid lg:grid-cols-[16.5rem_minmax(0,1fr)]",
            )}
            tabIndex={-1}
          >
            {secondarySidebar && isDesktop ? (
              <aside className="sticky top-16 h-[calc(100dvh-4rem)] min-w-0 self-start overflow-hidden border-r border-separator bg-background">
                {secondarySidebar}
              </aside>
            ) : null}
            <div className="min-w-0">{children}</div>
          </main>
        </div>
      </div>
      <Drawer.Backdrop
        isOpen={sidebarOpen && !isDesktop}
        onOpenChange={onSidebarOpenChange}
      >
        <Drawer.Content placement="left">
          <Drawer.Dialog
            id="application-navigation"
            aria-label="Rootset navigation"
            data-secondary-navigation={!!secondarySidebar}
            className="application-navigation-drawer grid max-w-[calc(100vw-1rem)] overflow-hidden bg-background p-0"
          >
            <div
              className="relative h-full min-h-0 min-w-0"
              data-slot="drawer-body"
            >
              {sidebar}
              {!secondarySidebar && (
                <Drawer.CloseTrigger
                  autoFocus
                  aria-label="Close navigation"
                  className="end-3 top-4 size-8 bg-transparent hover:bg-transparent data-[hovered=true]:bg-transparent"
                />
              )}
            </div>
            {secondarySidebar && (
              <div className="flex h-full min-h-0 min-w-0 flex-col border-l border-separator">
                <div className="relative min-h-16 shrink-0 border-b border-separator">
                  <Drawer.CloseTrigger
                    autoFocus
                    aria-label="Close navigation"
                    className="end-3 top-4 size-8 bg-transparent hover:bg-transparent data-[hovered=true]:bg-transparent"
                  />
                </div>
                <div className="min-h-0 flex-1">{secondarySidebar}</div>
              </div>
            )}
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </NavigationContext.Provider>
  );
}

export type ShellLinkConfig = {
  id: string;
  href: string;
  label: string;
  icon?: ReactNode;
  active?: boolean;
  trailing?: ReactNode;
  badge?: { value: number; label: string };
};
export type ShellActionConfig = Omit<ShellLinkConfig, "href" | "active"> & {
  href?: never;
  active?: never;
  onPress: () => void;
};
export type SidebarGroupConfig = {
  id: string;
  label?: string;
  header?: ReactNode;
  content?: ReactNode;
  footerContent?: ReactNode;
  items: (ShellLinkConfig | ShellActionConfig)[];
};
export type SidebarConfig = {
  accessibleLabel: string;
  brand: { title: string; logo: ReactNode };
  brandVersion?: string;
  homeHref: string;
  groups: SidebarGroupConfig[];
  footerContent?: ReactNode;
};

function RoutedLink({
  item,
  className,
  children,
}: {
  item: ShellLinkConfig;
  className?: string;
  children?: ReactNode;
}) {
  const { navigate, close } = useContext(NavigationContext);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(item.href);
    close();
  };
  return (
    <a
      aria-current={item.active ? "page" : undefined}
      className={className}
      href={item.href}
      onClick={onClick}
    >
      {children ?? item.label}
    </a>
  );
}

// Adapted from Towbar's secondary sidebar section composition.
export function SecondarySection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section data-secondary-menu className="grid min-w-0 gap-1">
      <h2 className="px-2 py-1.5 text-xs font-medium text-muted">{title}</h2>
      {children}
    </section>
  );
}

export function SecondarySidebar({
  title,
  hideTitle = false,
  items,
  actions,
  children,
}: {
  title: string;
  hideTitle?: boolean;
  items: ShellLinkConfig[];
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <nav
      aria-label={`${title} navigation`}
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain px-3 py-4"
    >
      {!hideTitle && (
        <div className="flex min-h-8 shrink-0 items-center justify-between gap-2 ps-2">
          <h2 className="text-xs font-medium text-muted">{title}</h2>
          {actions}
        </div>
      )}
      {children}
      <SecondaryLinks items={items} />
    </nav>
  );
}

export function SecondaryLinks({ items }: { items: ShellLinkConfig[] }) {
  return (
    <div className="grid gap-0.5">
      {items.map((item) => (
        <RoutedLink
          key={item.id}
          item={item}
          className={cn(
            "flex min-h-8 min-w-0 items-center gap-3 rounded-2xl px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus pointer-coarse:min-h-11",
            item.active
              ? "bg-default font-medium text-foreground"
              : "font-normal text-foreground hover:bg-default/60",
          )}
        >
          {item.icon}
          <span className="min-w-0 flex-1 break-words">{item.label}</span>
        </RoutedLink>
      ))}
    </div>
  );
}

export function ApplicationSidebar({ config }: { config: SidebarConfig }) {
  const { path } = useContext(NavigationContext);
  return (
    <nav
      aria-label={config.accessibleLabel}
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <RoutedLink
        className="inline-flex min-h-16 min-w-0 shrink-0 items-center gap-2.5 border-b border-separator px-4"
        item={{ id: "home", href: config.homeHref, label: config.brand.title }}
      >
        <span className="inline-flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="inline-grid size-8 shrink-0 place-items-center"
          >
            {config.brand.logo}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5 lg:flex-row lg:items-baseline lg:gap-2.5">
            <span className="truncate text-base font-medium">
              {config.brand.title}
            </span>
            {config.brandVersion && (
              <span
                aria-label={`Version ${config.brandVersion}`}
                className="shrink-0 font-mono text-xs font-normal text-muted"
              >
                v{config.brandVersion}
              </span>
            )}
          </span>
        </span>
      </RoutedLink>
      <div className="grid min-h-0 flex-1 content-start gap-1 overflow-y-auto overscroll-contain px-3 py-4">
        {config.groups.map((group) => (
          <section className="grid gap-1 [&+&]:mt-2" key={group.id}>
            {group.header ??
              (group.label ? (
                <h2 className="px-2 py-1.5 text-xs font-medium text-muted">
                  {group.label}
                </h2>
              ) : null)}
            {group.content}
            <div className="grid gap-0.5">
              {group.items.map((item) => {
                const active =
                  item.active ??
                  (item.href !== undefined &&
                    (path === item.href ||
                      (item.href !== "/" && path.startsWith(`${item.href}/`))));
                const className = cn(
                  "flex min-h-8 min-w-0 items-center gap-3 rounded-2xl px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus pointer-coarse:min-h-11",
                  active
                    ? "bg-default font-medium text-foreground"
                    : "font-normal text-muted hover:bg-default/60 hover:text-foreground",
                );
                const content = (
                  <>
                    {item.icon}
                    <span className="min-w-0 flex-1 break-words">
                      {item.label}
                    </span>
                    {item.trailing}
                    {item.badge ? (
                      <span
                        aria-label={item.badge.label}
                        title={item.badge.label}
                        className="ms-auto min-w-4 shrink-0 text-end font-mono text-xs tabular-nums text-muted lg:min-w-5"
                      >
                        {item.badge.value}
                      </span>
                    ) : null}
                  </>
                );
                if (item.href === undefined)
                  return (
                    <Button
                      key={item.id}
                      variant="secondary"
                      className={cn(
                        className,
                        "h-auto w-full justify-start text-start",
                      )}
                      onPress={item.onPress}
                    >
                      {content}
                    </Button>
                  );
                return (
                  <RoutedLink
                    className={className}
                    item={{ ...item, active }}
                    key={item.id}
                  >
                    {content}
                  </RoutedLink>
                );
              })}
            </div>
            {group.footerContent}
          </section>
        ))}
      </div>
      {config.footerContent ? (
        <div className="shrink-0 border-t border-separator pb-[env(safe-area-inset-bottom)]">
          {config.footerContent}
        </div>
      ) : null}
    </nav>
  );
}

export type NavbarProps = {
  title: ReactNode;
  actions?: ReactNode;
  sidebarOpen: boolean;
  onSidebarToggle: () => void;
};

export function Navbar({
  title,
  actions,
  sidebarOpen,
  onSidebarToggle,
}: NavbarProps) {
  return (
    <header className="sticky top-0 z-30 flex min-h-16 items-center justify-between gap-5 border-b border-separator bg-background/90 pl-2 pr-4 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          aria-label={sidebarOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={sidebarOpen}
          aria-controls={sidebarOpen ? "application-navigation" : undefined}
          className="navigation-toggle relative size-8 shrink-0 before:absolute before:-inset-1.5 before:content-['']"
          isIconOnly
          onPress={onSidebarToggle}
          variant="ghost"
        >
          <HugeiconsIcon
            aria-hidden="true"
            className="size-4"
            icon={Menu01Icon}
          />
        </Button>
        <div className="min-w-0 flex-1 text-sm font-medium">{title}</div>
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

export const ApplicationNavbar = Navbar;

export type ThemeSwitcherProps = Omit<
  ComponentProps<"button">,
  "children" | "onClick" | "type"
> & {
  theme: string;
  onThemeChange: (theme: "light" | "dark") => void;
  label?: string;
  size?: "default" | "small";
};

export function ThemeSwitcher({
  className,
  label = "Appearance",
  size = "default",
  theme,
  onThemeChange,
  ...props
}: ThemeSwitcherProps) {
  const nextTheme = theme === "dark" ? "light" : "dark";
  return (
    <button
      aria-label={`${label}: switch to ${nextTheme} theme`}
      className={cn(
        "relative isolate grid shrink-0 cursor-pointer touch-manipulation place-items-center rounded-full bg-default text-muted outline-none transition-[color,background-color,transform] hover:bg-default/80 hover:text-foreground active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none",
        size === "small" ? "size-8" : "size-10",
        className,
      )}
      data-slot="theme-switcher"
      title={`Switch to ${nextTheme} theme`}
      type="button"
      onClick={() => onThemeChange(nextTheme)}
      {...props}
    >
      <HugeiconsIcon
        aria-hidden="true"
        className="size-4"
        icon={theme === "dark" ? Moon02Icon : Sun03Icon}
      />
    </button>
  );
}

export type FooterIdentityProps = {
  name: string;
  email: string;
  roleLabel: string;
  onLogout: () => void;
  children?: ReactNode;
};

export function FooterIdentity({
  name,
  email,
  roleLabel,
  onLogout,
  children,
}: FooterIdentityProps) {
  const { navigate, close, sidebarOpen, focusNavigationToggle } =
    useContext(NavigationContext);
  const [menuOpen, setMenuOpen] = useState(false);

  useLayoutEffect(() => {
    if (menuOpen && !sidebarOpen) {
      const frame = requestAnimationFrame(() => {
        setMenuOpen(false);
        focusNavigationToggle();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [focusNavigationToggle, menuOpen, sidebarOpen]);

  return (
    <Dropdown isOpen={menuOpen && sidebarOpen} onOpenChange={setMenuOpen}>
      <Dropdown.Trigger
        aria-label={`Account menu for ${name}`}
        className="sidebar-identity flex min-h-16 w-full min-w-0 items-center gap-2.5 px-4 py-3 text-start text-sm"
      >
        <Avatar
          aria-hidden="true"
          className="size-9"
          size="md"
          email={email}
          name={name}
        />
        <span className="grid min-w-0 flex-1 gap-0.25">
          <span className="truncate font-medium">{name}</span>
          <span className="truncate text-xs text-foreground/70">
            {roleLabel}
          </span>
        </span>
      </Dropdown.Trigger>
      <Dropdown.Popover
        className="max-h-[calc(100dvh-2rem)] w-60 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-separator"
        placement="top start"
      >
        <div className="grid gap-0.25 border-b border-separator px-3 py-3">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="truncate text-xs text-muted">{email}</div>
        </div>
        <Dropdown.Menu
          aria-label="Account menu"
          onAction={(key) => {
            if (key === "logout") onLogout();
            else if (
              [
                "profile",
                "preferences",
                "email-password",
                "2fa",
                "api-keys",
                "mcp",
              ].includes(String(key))
            )
              navigate(`/settings/${key}`);
            close();
          }}
        >
          {children ?? (
            <Dropdown.Section aria-label="Account">
              <Dropdown.Item id="profile" textValue="Profile">
                <HugeiconsIcon
                  aria-hidden="true"
                  className="size-4 text-muted"
                  icon={UserAccountIcon}
                />
                Profile
              </Dropdown.Item>
              <Dropdown.Item id="2fa" textValue="Account security">
                <HugeiconsIcon
                  aria-hidden="true"
                  className="size-4 text-muted"
                  icon={SecurityCheckIcon}
                />
                Account security
              </Dropdown.Item>
            </Dropdown.Section>
          )}
          <Dropdown.Section
            aria-label="Session"
            className="mt-1.5 w-full border-t border-separator pt-1.5"
          >
            <Dropdown.Item id="logout" textValue="Sign out" variant="danger">
              <HugeiconsIcon
                aria-hidden="true"
                className="size-4 text-danger-soft-foreground"
                icon={Logout03Icon}
              />
              <span className="text-danger-soft-foreground">Sign out</span>
            </Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
