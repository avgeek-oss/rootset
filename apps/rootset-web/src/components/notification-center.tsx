"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NotificationMenu } from "@avgeek-oss/design-system/patterns/notifications";
import { Widget } from "@avgeek-oss/design-system/data-display/widget";
import { QueryError } from "@avgeek-oss/design-system/patterns/feedback/query-state";
import { usePageVisibilityInterval } from "@avgeek-oss/design-system/hooks/use-page-visibility-interval";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import type { NotificationPage } from "@rootset/contracts";
import { RootsetClient } from "@rootset/web-client";
import { formatDistanceStrict } from "date-fns";

const client = new RootsetClient();
const pageSize = 50;
export function NotificationCenter() {
  const [isOpen, setIsOpen] = useState(false);
  const [feed, setFeed] = useState<NotificationPage>({
    notifications: [],
    unreadCount: 0,
    nextCursor: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markingRead, setMarkingRead] = useState(false);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = useRef<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);

  const load = useCallback(async (target = cursor.current) => {
    const requestGeneration = ++generation.current;
    setLoading(true);
    try {
      const page = await client.operation<NotificationPage>(
        "listNotifications",
        { limit: pageSize, cursor: target },
      );
      if (generation.current !== requestGeneration) return false;
      setFeed(page);
      setError(null);
      cursor.current = target;
      return true;
    } catch (cause) {
      if (generation.current === requestGeneration)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load notifications",
        );
      return false;
    } finally {
      if (generation.current === requestGeneration) setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      await load();
    } finally {
      pending.current = false;
    }
  }, [load]);
  usePageVisibilityInterval(() => void refresh(), 30_000, {
    runImmediately: true,
  });
  useEffect(() => {
    if (isOpen) void refresh();
  }, [isOpen, refresh]);

  const markAllRead = async () => {
    if (pending.current) return;
    pending.current = true;
    setMarkingRead(true);
    try {
      await client.operation("markAllNotificationsRead", {});
      if (await load(null)) setCursors([null]);
    } catch (cause) {
      toast.danger(
        cause instanceof Error
          ? cause.message
          : "Could not mark notifications as read",
      );
    } finally {
      pending.current = false;
      setMarkingRead(false);
    }
  };
  const changePage = async (next: Array<string | null>) => {
    if (pending.current) return;
    pending.current = true;
    try {
      if (await load(next.at(-1) ?? null)) setCursors(next);
    } finally {
      pending.current = false;
    }
  };
  const retry = error ? (
    <QueryError message={error} onRetry={() => void refresh()} />
  ) : null;
  const paginated = cursors.length > 1 || Boolean(feed.nextCursor);
  return (
    <NotificationMenu
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      unreadCount={feed.unreadCount}
      loading={loading && feed.notifications.length === 0}
      markingRead={markingRead}
      onMarkAllRead={() => void markAllRead()}
      headerEnd={
        <Widget.Action
          isDisabled={loading || markingRead || !feed.unreadCount}
          onPress={() => void markAllRead()}
        >
          {markingRead ? "Marking read…" : "Mark all as read"}
        </Widget.Action>
      }
      emptyContent={retry ?? undefined}
      footer={
        retry && feed.notifications.length ? (
          retry
        ) : paginated ? (
          <div className="flex items-center justify-between gap-2">
            <Widget.Action
              isDisabled={loading || markingRead || cursors.length === 1}
              onPress={() => void changePage(cursors.slice(0, -1))}
            >
              Previous
            </Widget.Action>
            <span className="text-xs text-muted tabular-nums" role="status">
              Page {cursors.length}
            </span>
            <Widget.Action
              isDisabled={loading || markingRead || !feed.nextCursor}
              onPress={() => void changePage([...cursors, feed.nextCursor])}
            >
              Next
            </Widget.Action>
          </div>
        ) : undefined
      }
      items={feed.notifications.map((notification) => ({
        id: notification.id,
        title: notification.payload.title,
        message: notification.payload.message,
        source: notification.payload.databaseName,
        href: `/settings/backups?databaseId=${encodeURIComponent(notification.payload.databaseId)}`,
        icon: (
          <span
            className={`mt-1 size-2 rounded-full ${notification.type === "backup.succeeded" ? "bg-success" : notification.type === "backup.failed" ? "bg-danger" : "bg-warning"}`}
          />
        ),
        time: formatDistanceStrict(
          new Date(notification.occurredAt),
          new Date(),
          { addSuffix: true },
        ),
        dateTime: notification.occurredAt,
        unread: notification.readAt === null,
      }))}
    />
  );
}
