"use client";

import { defineClientTool, useAgentChat } from "@avgeek-oss/agent-react";
import {
  AgentChat,
  type AgentConversationSummary,
} from "@avgeek-oss/design-system/patterns/agent-chat/agent-chat";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { browserApiOrigin } from "@rootset/web-client";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

export function Assistant({
  workspaceId,
  workspaceName,
  entityNames,
  onClose,
}: {
  workspaceId: string;
  workspaceName: string;
  entityNames?: Record<string, string>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const assistantFetch = useCallback<typeof fetch>(
    (input, init) => {
      const url = new URL(browserApiOrigin() + String(input));
      url.searchParams.set("workspaceId", workspaceId);
      return fetch(url, {
        ...init,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
      });
    },
    [workspaceId],
  );
  const clientTools = useMemo(
    () => [
      defineClientTool({
        name: "refresh_page_data",
        description: "Refresh visible records and schemas after data changes.",
        input: z.object({}),
        run: async () => {
          await queryClient.invalidateQueries();
          return "Page data refreshed.";
        },
      }),
      defineClientTool({
        name: "open_database_list",
        description: "Open the databases in the current workspace.",
        input: z.object({}),
        run: () => {
          router.push(
            `/databases?workspaceId=${encodeURIComponent(workspaceId)}`,
          );
          return "Opened databases.";
        },
      }),
    ],
    [queryClient, router, workspaceId],
  );
  const chat = useAgentChat({
    endpoint: "/api/internal/v1/agent",
    fetch: assistantFetch,
    clientTools,
  });
  const refreshPage = useCallback(() => {
    void queryClient
      .invalidateQueries()
      .catch(() =>
        toast.danger("Page data could not be refreshed. Try again."),
      );
  }, [queryClient]);
  const approvedCalls = useRef(new Set<string>());
  useEffect(() => {
    for (const item of chat.state.items) {
      if (
        item.type !== "tool_call" ||
        item.status === "pending" ||
        !approvedCalls.current.delete(item.id)
      )
        continue;
      if (item.status === "succeeded") refreshPage();
    }
  }, [chat.state.items, refreshPage]);
  const displayedItems = useMemo(
    () =>
      chat.state.items.map((item) => {
        if (
          item.type !== "tool_call" ||
          !item.input ||
          typeof item.input !== "object" ||
          Array.isArray(item.input)
        )
          return item;
        const input = Object.fromEntries(
          Object.entries(item.input).flatMap(([key, value]) => {
            if (["idempotencyKey", "orgId"].includes(key)) return [];
            if (key === "workspaceId") return [["workspace", workspaceName]];
            if (typeof value === "string" && entityNames?.[value])
              return [[key.replace(/Id$/, ""), entityNames[value]]];
            return [[key, value]];
          }),
        );
        return { ...item, input, name: item.name.replace(/^rootset_/, "") };
      }),
    [chat.state.items, workspaceName, entityNames],
  );
  const [conversations, setConversations] = useState<
    AgentConversationSummary[]
  >([]);
  const { listConversations, stop } = chat;
  const refresh = useCallback(async () => {
    const list = await listConversations();
    setConversations(
      list.map((item) => ({
        id: item.id,
        title: item.title,
        time: new Date(item.updatedAt).toLocaleDateString(),
        dateTime: item.updatedAt,
      })),
    );
  }, [listConversations]);
  useEffect(() => {
    if (chat.state.status === "idle")
      void refresh().catch(() =>
        toast.danger("Conversation history could not be loaded. Try again."),
      );
  }, [chat.state.status, refresh]);
  useEffect(() => () => stop(), [stop]);
  return (
    <AgentChat
      productName="Rootset"
      items={displayedItems}
      pending={chat.state.pending}
      status={chat.state.status}
      error={chat.state.error}
      thinking={chat.state.thinking}
      onSend={(text) => {
        void chat.send(text);
      }}
      onDecide={(id, approved) => {
        if (approved) approvedCalls.current.add(id);
        chat.decide(id, approved);
      }}
      onStop={chat.stop}
      onNewConversation={() => {
        approvedCalls.current.clear();
        chat.reset();
      }}
      onClose={onClose}
      suggestions={[
        "Which databases are available?",
        "Describe the tables in this workspace.",
        "Show recent changes.",
      ]}
      emptyDescription="Ask about databases and records, or prepare a change for approval."
      conversations={conversations}
      activeConversationId={chat.state.conversationId}
      onSelectConversation={(id) => {
        void chat.load(id);
      }}
      onDeleteConversation={async (id) => {
        await chat.deleteConversation(id);
        await refresh();
      }}
    />
  );
}
