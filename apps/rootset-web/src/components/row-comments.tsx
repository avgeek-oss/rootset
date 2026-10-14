"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@avgeek-oss/design-system/buttons/button";
import { Avatar } from "@avgeek-oss/design-system/data-display/avatar";
import { Textarea } from "@avgeek-oss/design-system/forms/textarea";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { Drawer } from "@avgeek-oss/design-system/overlays/drawer";
import { client } from "@rootset/web-client";
import type { RowComment } from "@rootset/contracts";
import { Trash2 } from "./ui/icons";
import { MutationAttempt } from "../lib/mutation-attempt";
import { useConfirmation } from "./settings/ui";
import "./row-comments.css";

interface Target {
  orgId: string;
  databaseId: string;
  tableId: string;
}
interface CommentPage {
  data: RowComment[];
  hasMore: boolean;
  nextCursor: string | null;
}
function relativeTime(value: string, now: number, locale: string): string {
  const seconds = Math.min(
    0,
    Math.round((new Date(value).getTime() - now) / 1000),
  );
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  if (Math.abs(seconds) < 3600)
    return formatter.format(Math.round(seconds / 60), "minute");
  if (Math.abs(seconds) < 86400)
    return formatter.format(Math.round(seconds / 3600), "hour");
  return formatter.format(Math.round(seconds / 86400), "day");
}

interface RowCommentsProps {
  target: Target & { rowId: string };
  rowNumber: number;
  isOpen: boolean;
  canCreate: boolean;
  locale: string;
  timeZone: string;
  onClose: () => void;
  onPresenceChange: (rowId: string, hasComments: boolean) => void;
}

export function RowComments(props: RowCommentsProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Drawer
      isOpen={props.isOpen}
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <Drawer.Backdrop isDismissable={false} isKeyboardDismissDisabled={busy}>
        <Drawer.Content placement="right">
          <RowDiscussion {...props} busy={busy} setBusy={setBusy} />
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}

function RowDiscussion({
  target,
  rowNumber,
  canCreate,
  locale,
  timeZone,
  onPresenceChange,
  busy,
  setBusy,
}: RowCommentsProps & {
  busy: boolean;
  setBusy: (busy: boolean) => void;
}) {
  const cache = useQueryClient();
  const confirmation = useConfirmation();
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const attempt = useRef(new MutationAttempt());
  const deleteAttempt = useRef(new MutationAttempt());
  const composer = useRef<HTMLTextAreaElement>(null);
  const commentList = useRef<HTMLDivElement>(null);
  const key = ["row-comments", target.tableId, target.rowId];
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const comments = useQuery({
    queryKey: [...key, cursor],
    queryFn: ({ signal }) =>
      client.operation<CommentPage>(
        "listRowComments",
        { ...target, limit: 50, cursor },
        { signal },
      ),
    gcTime: 0,
  });
  const displayTime = Math.max(now, comments.dataUpdatedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (cursor === null && comments.data)
      onPresenceChange(target.rowId, comments.data.data.length > 0);
  }, [cursor, comments.data, target.rowId, onPresenceChange]);
  async function refresh() {
    await cache.invalidateQueries({ queryKey: key });
    if (cursor !== null) {
      const firstPage = await client.operation<CommentPage>("listRowComments", {
        ...target,
        limit: 1,
        cursor: null,
      });
      onPresenceChange(target.rowId, firstPage.data.length > 0);
    }
  }
  async function create() {
    if (busy || !body.trim() || !canCreate) return;
    setBusy(true);
    setError("");
    const input = { ...target, body };
    try {
      await client.operation("createRowComment", input, {
        idempotencyKey: attempt.current.forInput(input),
      });
      attempt.current.clear();
      setBody("");
      await refresh();
      toast.success("Comment added");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to add comment. Retry.",
      );
    } finally {
      setBusy(false);
      requestAnimationFrame(() => composer.current?.focus());
    }
  }
  async function remove(comment: RowComment) {
    if (
      !(await confirmation.confirm(
        "Delete comment?",
        "This permanently removes the comment’s content. The comment log will remain and cannot be removed.",
        "Delete comment",
      ))
    )
      return;
    setBusy(true);
    setError("");
    const input = { ...target, commentId: comment.id };
    try {
      await client.operation("deleteRowComment", input, {
        idempotencyKey: deleteAttempt.current.forInput(input),
      });
      deleteAttempt.current.clear();
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to delete comment. Retry.",
      );
    } finally {
      setBusy(false);
      requestAnimationFrame(() => composer.current?.focus());
    }
  }
  return (
    <Drawer.Dialog className="row-comments-drawer">
      <Drawer.Header className="row-comments-header">
        <Drawer.Heading>Row {rowNumber} comments</Drawer.Heading>
        <Drawer.CloseTrigger aria-label="Close comments" isDisabled={busy} />
      </Drawer.Header>
      <Drawer.Body
        className="row-discussion"
        aria-busy={busy || comments.isFetching}
      >
        {comments.isPending && (
          <p role="status" className="text-muted">
            Loading comments…
          </p>
        )}
        {comments.isError && (
          <div role="alert">
            <p>{comments.error.message}</p>
            <Button variant="secondary" onPress={() => void comments.refetch()}>
              Retry loading comments
            </Button>
          </div>
        )}
        <div
          ref={commentList}
          className="row-comment-list"
          role="group"
          aria-label="Comments on this page"
          tabIndex={-1}
        >
          {comments.data?.data.map((comment) => (
            <article
              key={comment.id}
              className="row-comment"
              aria-label={`Comment by ${comment.authorName}`}
            >
              <Avatar
                className="size-7 shrink-0"
                aria-label={comment.authorName}
              >
                <Avatar.Fallback className="text-xs">
                  {comment.authorName
                    .trim()
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((word) => word[0])
                    .join("")
                    .toUpperCase()}
                </Avatar.Fallback>
              </Avatar>
              <div className="row-comment-content">
                <div className="row-comment-byline">
                  <span className="row-comment-author">
                    {comment.authorName}
                  </span>
                  <time
                    dateTime={comment.createdAt}
                    title={new Date(comment.createdAt).toLocaleString(locale, {
                      timeZone,
                    })}
                  >
                    {relativeTime(comment.createdAt, displayTime, locale)}
                  </time>
                </div>
                <p
                  className={`row-comment-body${comment.deletedAt ? " row-comment-deleted" : ""}`}
                >
                  {comment.deletedAt ? "comment deleted" : comment.body}
                </p>
              </div>
              {comment.canDelete && !comment.deletedAt && (
                <Button
                  variant="ghost"
                  isIconOnly
                  size="sm"
                  aria-label={`Delete comment by ${comment.authorName}`}
                  isDisabled={busy}
                  onPress={() => void remove(comment)}
                >
                  <Trash2 />
                </Button>
              )}
            </article>
          ))}
          {comments.isSuccess && comments.data.data.length === 0 && (
            <p className="text-muted">
              {cursor ? "No more comments on this page." : "No comments yet."}
              {!cursor && canCreate ? " Start the discussion below." : ""}
            </p>
          )}
        </div>
        {(cursor || comments.data?.hasMore) && (
          <div className="row-comment-pagination">
            <Button
              variant="secondary"
              isDisabled={busy || comments.isFetching || !cursor}
              onPress={() => {
                setCursors((previous) => previous.slice(0, -1));
                commentList.current?.focus();
              }}
            >
              Previous comments
            </Button>
            <Button
              variant="secondary"
              isDisabled={
                busy || comments.isFetching || !comments.data?.nextCursor
              }
              onPress={() => {
                if (comments.data?.nextCursor) {
                  setCursors((previous) => [
                    ...previous,
                    comments.data!.nextCursor,
                  ]);
                  commentList.current?.focus();
                }
              }}
            >
              Next comments
            </Button>
          </div>
        )}
      </Drawer.Body>
      {(canCreate || error) && (
        <Drawer.Footer className="row-comments-footer">
          {error && (
            <p role="alert" className="row-comment-error">
              {error}
            </p>
          )}
          {canCreate && (
            <form
              className="row-comment-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <label htmlFor="row-comment-body">Add a comment</label>
              <Textarea
                ref={composer}
                variant="secondary"
                id="row-comment-body"
                name="comment"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={4096}
                rows={3}
                disabled={busy}
                placeholder="Write a comment…"
                onKeyDown={(event) => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    void create();
                  }
                }}
              />
              <div className="row-comment-compose-actions">
                <span className="text-muted">
                  {body.length.toLocaleString()} / 4,096
                </span>
                <Button type="submit" isDisabled={busy || !body.trim()}>
                  {busy ? "Saving…" : "Add comment"}
                </Button>
              </div>
            </form>
          )}
        </Drawer.Footer>
      )}
      {confirmation.dialog}
    </Drawer.Dialog>
  );
}
