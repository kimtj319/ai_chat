import {
  createContext,
  useCallback,
  useMemo,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import * as api from "../api/client";
import type {
  Conversation,
  ConversationSettings,
  ConversationSummary,
  ReasoningLevel,
  ReasoningMode,
  Session,
} from "../api/types";
import type { ImportedConversationShell } from "./exportImport";
import { loadUiPreferences, saveUiPreferences } from "./storage";
import type { ClientChatMessage, ThemeMode, UiPreferences } from "./types";

/** The active conversation, with client-side streaming state on its messages. */
export interface ActiveConversation extends Omit<Conversation, "messages"> {
  messages: ClientChatMessage[];
}

interface State {
  ui: UiPreferences;
  session: Session | null;
  conversations: ConversationSummary[];
  conversationsLoading: boolean;
  conversationsError: string | null;
  activeConversationId: string | null;
  activeConversation: ActiveConversation | null;
  activeConversationLoading: boolean;
  activeConversationError: string | null;
}

type Action =
  | { type: "SET_UI"; patch: Partial<UiPreferences> }
  | { type: "SET_SESSION"; session: Session }
  | { type: "SET_CONVERSATIONS_LOADING" }
  | { type: "SET_CONVERSATIONS"; conversations: ConversationSummary[] }
  | { type: "SET_CONVERSATIONS_ERROR"; error: string }
  | { type: "REMOVE_CONVERSATION_SUMMARY"; id: string }
  | { type: "SET_ACTIVE_ID"; id: string | null }
  | { type: "SET_ACTIVE_LOADING" }
  | { type: "SET_ACTIVE_CONVERSATION"; conversation: Conversation }
  | { type: "SET_ACTIVE_ERROR"; error: string }
  | { type: "PATCH_ACTIVE_META"; patch: Partial<Conversation> }
  | { type: "APPEND_ACTIVE_MESSAGE"; conversationId: string; message: ClientChatMessage }
  | { type: "PATCH_ACTIVE_MESSAGE"; conversationId: string; messageId: string; patch: Partial<ClientChatMessage> }
  | { type: "REPLACE_ACTIVE_MESSAGE"; conversationId: string; tempId: string; message: ClientChatMessage };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SET_UI":
      return { ...state, ui: { ...state.ui, ...action.patch } };

    case "SET_SESSION":
      return { ...state, session: action.session };

    case "SET_CONVERSATIONS_LOADING":
      return { ...state, conversationsLoading: true, conversationsError: null };

    case "SET_CONVERSATIONS": {
      // The turn that just ended can settle the conversation's kind on the
      // server (an embedding model makes it an embedding conversation). The
      // refreshed summary carries that; the active record we are holding was
      // fetched before the turn and does not, so without this it keeps
      // offering chat affordances until the conversation is reopened.
      const active = state.activeConversation;
      const summary = active ? action.conversations.find((c) => c.id === active.id) : undefined;
      return {
        ...state,
        conversations: action.conversations,
        activeConversation:
          active && summary && summary.kind !== active.kind ? { ...active, kind: summary.kind } : active,
        conversationsLoading: false,
        conversationsError: null,
      };
    }

    case "SET_CONVERSATIONS_ERROR":
      return { ...state, conversationsLoading: false, conversationsError: action.error };

    case "REMOVE_CONVERSATION_SUMMARY":
      return { ...state, conversations: state.conversations.filter((c) => c.id !== action.id) };

    case "SET_ACTIVE_ID":
      return {
        ...state,
        activeConversationId: action.id,
        activeConversation: null,
        activeConversationError: null,
      };

    case "SET_ACTIVE_LOADING":
      return { ...state, activeConversationLoading: true, activeConversationError: null };

    case "SET_ACTIVE_CONVERSATION":
      if (action.conversation.id !== state.activeConversationId) return state;
      return {
        ...state,
        activeConversation: action.conversation as ActiveConversation,
        activeConversationLoading: false,
        activeConversationError: null,
      };

    case "SET_ACTIVE_ERROR":
      return { ...state, activeConversationLoading: false, activeConversationError: action.error };

    case "PATCH_ACTIVE_META": {
      if (!state.activeConversation) return state;
      return { ...state, activeConversation: { ...state.activeConversation, ...action.patch } };
    }

    case "APPEND_ACTIVE_MESSAGE": {
      if (!state.activeConversation || state.activeConversation.id !== action.conversationId) return state;
      return {
        ...state,
        activeConversation: {
          ...state.activeConversation,
          messages: [...state.activeConversation.messages, action.message],
        },
      };
    }

    case "PATCH_ACTIVE_MESSAGE": {
      if (!state.activeConversation || state.activeConversation.id !== action.conversationId) return state;
      return {
        ...state,
        activeConversation: {
          ...state.activeConversation,
          messages: state.activeConversation.messages.map((m) =>
            m.id === action.messageId ? { ...m, ...action.patch } : m,
          ),
        },
      };
    }

    case "REPLACE_ACTIVE_MESSAGE": {
      if (!state.activeConversation || state.activeConversation.id !== action.conversationId) return state;
      return {
        ...state,
        activeConversation: {
          ...state.activeConversation,
          messages: state.activeConversation.messages.map((m) => (m.id === action.tempId ? action.message : m)),
        },
      };
    }

    default:
      return state;
  }
}

function init(): State {
  return {
    ui: loadUiPreferences(),
    session: null,
    conversations: [],
    conversationsLoading: true,
    conversationsError: null,
    activeConversationId: null,
    activeConversation: null,
    activeConversationLoading: false,
    activeConversationError: null,
  };
}

/**
 * 열려 있는 대화 그 자체. **토큰 하나마다 바뀐다.**
 *
 * 나머지와 갈라 둔 이유가 그것이다. 예전에는 27개 값이 한 객체에 담겨 있었고,
 * 답변이 흘러나오는 동안 그 객체가 매 토큰마다 새로 만들어졌다 — 메시지를
 * 그리지도 않는 사이드바·작성창·도구판까지 전부 다시 그려졌다는 뜻이다.
 * 지금은 이걸 읽는 셋(ChatView·Sidebar·ModelSelector)만 따라 움직인다.
 */
export interface ActiveConversationValue {
  activeConversation: ActiveConversation | null;
  activeConversationLoading: boolean;
  activeConversationError: string | null;
}

/** 흐르지 않는 쪽. 대화를 고르거나 목록이 바뀔 때만 움직인다. */
interface StoreValue {
  ui: UiPreferences;
  session: Session | null;
  conversations: ConversationSummary[];
  conversationsLoading: boolean;
  conversationsError: string | null;
  activeConversationId: string | null;

  setTheme: (theme: ThemeMode) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setLastReasoning: (level: ReasoningLevel, thinkingTokenBudget: number) => void;
  setLastReasoningMode: (mode: ReasoningMode) => void;
  setLastModel: (model: string) => void;

  refreshConversations: () => Promise<void>;
  selectConversation: (id: string | null) => Promise<void>;
  createConversation: () => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  updateSystemPrompt: (systemPrompt: string) => Promise<void>;
  updateSettings: (settings: ConversationSettings) => Promise<void>;
  updateEnabledTools: (enabledTools: string[]) => Promise<void>;
  updateModel: (model: string) => Promise<void>;
  importConversation: (shell: ImportedConversationShell) => Promise<void>;

  appendMessage: (conversationId: string, message: ClientChatMessage) => void;
  patchMessage: (conversationId: string, messageId: string, patch: Partial<ClientChatMessage>) => void;
  replaceMessage: (conversationId: string, tempId: string, message: ClientChatMessage) => void;
}

const StoreContext = createContext<StoreValue | null>(null);
const ActiveConversationContext = createContext<ActiveConversationValue | null>(null);

const UI_PERSIST_DEBOUNCE_MS = 300;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, init);

  useEffect(() => {
    const timeout = setTimeout(() => saveUiPreferences(state.ui), UI_PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [state.ui]);

  // On load: establish/confirm the session, then fetch the conversation list.
  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const session = await api.getSession();
        if (cancelled) return;
        dispatch({ type: "SET_SESSION", session });
      } catch {
        // Session failure surfaces via the health banner instead.
      }
      dispatch({ type: "SET_CONVERSATIONS_LOADING" });
      try {
        const conversations = await api.listConversations();
        if (cancelled) return;
        dispatch({ type: "SET_CONVERSATIONS", conversations });
      } catch (error) {
        if (cancelled) return;
        dispatch({ type: "SET_CONVERSATIONS_ERROR", error: error instanceof Error ? error.message : String(error) });
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const setTheme = useCallback((theme: ThemeMode) => dispatch({ type: "SET_UI", patch: { theme } }), []);
  const setSidebarCollapsed = useCallback(
    (sidebarCollapsed: boolean) => dispatch({ type: "SET_UI", patch: { sidebarCollapsed } }),
    [],
  );
  const setLastReasoning = useCallback(
    (lastReasoningLevel: ReasoningLevel, lastThinkingTokenBudget: number) =>
      dispatch({ type: "SET_UI", patch: { lastReasoningLevel, lastThinkingTokenBudget } }),
    [],
  );
  const setLastReasoningMode = useCallback(
    (lastReasoningMode: ReasoningMode) => dispatch({ type: "SET_UI", patch: { lastReasoningMode } }),
    [],
  );
  const setLastModel = useCallback((lastModel: string) => dispatch({ type: "SET_UI", patch: { lastModel } }), []);

  const refreshConversations = useCallback(async () => {
    dispatch({ type: "SET_CONVERSATIONS_LOADING" });
    try {
      const conversations = await api.listConversations();
      dispatch({ type: "SET_CONVERSATIONS", conversations });
    } catch (error) {
      dispatch({ type: "SET_CONVERSATIONS_ERROR", error: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const selectConversation = useCallback(async (id: string | null) => {
    dispatch({ type: "SET_ACTIVE_ID", id });
    if (id === null) return;
    dispatch({ type: "SET_ACTIVE_LOADING" });
    try {
      const conversation = await api.getConversation(id);
      dispatch({ type: "SET_ACTIVE_CONVERSATION", conversation });
    } catch (error) {
      dispatch({ type: "SET_ACTIVE_ERROR", error: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const uiRef = useRef(state.ui);
  uiRef.current = state.ui;
  const activeConversationRef = useRef(state.activeConversation);
  activeConversationRef.current = state.activeConversation;

  const createConversation = useCallback(async () => {
    const ui = uiRef.current;
    const conversation = await api.createConversation(ui.lastModel ? { model: ui.lastModel } : {});
    const wantsCustomDefault =
      ui.lastReasoningLevel !== conversation.settings.reasoningLevel ||
      ui.lastReasoningMode !== conversation.settings.reasoningMode ||
      ui.lastThinkingTokenBudget !== conversation.settings.thinkingTokenBudget;
    let finalConversation = conversation;
    if (wantsCustomDefault) {
      finalConversation = await api.patchConversation(conversation.id, {
        settings: {
          ...conversation.settings,
          reasoningLevel: ui.lastReasoningLevel,
          reasoningMode: ui.lastReasoningMode,
          thinkingTokenBudget: ui.lastThinkingTokenBudget,
        },
      });
    }
    dispatch({ type: "SET_ACTIVE_ID", id: finalConversation.id });
    dispatch({ type: "SET_ACTIVE_CONVERSATION", conversation: finalConversation });
    await refreshConversations();
  }, [refreshConversations, uiRef]);

  const deleteConversation = useCallback(
    async (id: string) => {
      await api.deleteConversation(id);
      dispatch({ type: "REMOVE_CONVERSATION_SUMMARY", id });
      if (state.activeConversationId === id) {
        dispatch({ type: "SET_ACTIVE_ID", id: null });
      }
    },
    [state.activeConversationId],
  );

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      const updated = await api.patchConversation(id, { title });
      if (state.activeConversationId === id) {
        dispatch({ type: "PATCH_ACTIVE_META", patch: { title: updated.title, updatedAt: updated.updatedAt } });
      }
      await refreshConversations();
    },
    [refreshConversations, state.activeConversationId],
  );

  const updateSystemPrompt = useCallback(
    async (systemPrompt: string) => {
      const id = state.activeConversationId;
      if (!id) return;
      const updated = await api.patchConversation(id, { systemPrompt });
      dispatch({ type: "PATCH_ACTIVE_META", patch: { systemPrompt: updated.systemPrompt, updatedAt: updated.updatedAt } });
    },
    [state.activeConversationId],
  );

  const updateSettings = useCallback(
    async (settings: ConversationSettings) => {
      const id = state.activeConversationId;
      if (!id) return;
      const updated = await api.patchConversation(id, { settings });
      dispatch({ type: "PATCH_ACTIVE_META", patch: { settings: updated.settings, updatedAt: updated.updatedAt } });
    },
    [state.activeConversationId],
  );

  const updateEnabledTools = useCallback(
    async (enabledTools: string[]) => {
      const id = state.activeConversationId;
      if (!id) return;
      const updated = await api.patchConversation(id, { enabledTools });
      dispatch({ type: "PATCH_ACTIVE_META", patch: { enabledTools: updated.enabledTools, updatedAt: updated.updatedAt } });
    },
    [state.activeConversationId],
  );

  // Optimistic: the model switch applies to local state immediately so the
  // sidebar UI updates without waiting on the network, then reverts if the
  // PATCH fails (the caller surfaces the thrown error).
  const updateModel = useCallback(
    async (model: string) => {
      const id = state.activeConversationId;
      if (!id) return;
      const previous = activeConversationRef.current?.model ?? "";
      if (previous === model) return;
      dispatch({ type: "PATCH_ACTIVE_META", patch: { model } });
      try {
        const updated = await api.patchConversation(id, { model });
        dispatch({ type: "PATCH_ACTIVE_META", patch: { model: updated.model, updatedAt: updated.updatedAt } });
      } catch (error) {
        dispatch({ type: "PATCH_ACTIVE_META", patch: { model: previous } });
        throw error;
      }
    },
    [state.activeConversationId],
  );

  const importConversation = useCallback(
    async (shell: ImportedConversationShell) => {
      const conversation = await api.createConversation({ title: shell.title, systemPrompt: shell.systemPrompt });
      if (shell.settings || shell.enabledTools) {
        await api.patchConversation(conversation.id, {
          ...(shell.settings ? { settings: shell.settings } : {}),
          ...(shell.enabledTools ? { enabledTools: shell.enabledTools } : {}),
        });
      }
      await refreshConversations();
    },
    [refreshConversations],
  );

  const appendMessage = useCallback(
    (conversationId: string, message: ClientChatMessage) => dispatch({ type: "APPEND_ACTIVE_MESSAGE", conversationId, message }),
    [],
  );
  const patchMessage = useCallback(
    (conversationId: string, messageId: string, patch: Partial<ClientChatMessage>) =>
      dispatch({ type: "PATCH_ACTIVE_MESSAGE", conversationId, messageId, patch }),
    [],
  );
  const replaceMessage = useCallback(
    (conversationId: string, tempId: string, message: ClientChatMessage) =>
      dispatch({ type: "REPLACE_ACTIVE_MESSAGE", conversationId, tempId, message }),
    [],
  );

  // 두 값 모두 useMemo 로 감싼다. 객체 리터럴을 그대로 내려보내면 공급자가
  // 다시 그려질 때마다 새 객체가 되어, 안의 내용이 하나도 안 바뀌었어도 모든
  // 소비자가 따라 그려진다.
  const active: ActiveConversationValue = useMemo(
    () => ({
      activeConversation: state.activeConversation,
      activeConversationLoading: state.activeConversationLoading,
      activeConversationError: state.activeConversationError,
    }),
    [state.activeConversation, state.activeConversationLoading, state.activeConversationError],
  );

  const value: StoreValue = useMemo(
    () => ({
    ui: state.ui,
    session: state.session,
    conversations: state.conversations,
    conversationsLoading: state.conversationsLoading,
    conversationsError: state.conversationsError,
    activeConversationId: state.activeConversationId,
    setTheme,
    setSidebarCollapsed,
    setLastReasoning,
    setLastReasoningMode,
    setLastModel,
    refreshConversations,
    selectConversation,
    createConversation,
    deleteConversation,
    renameConversation,
    updateSystemPrompt,
    updateSettings,
    updateEnabledTools,
    updateModel,
    importConversation,
    appendMessage,
    patchMessage,
    replaceMessage,
    }),
    // 동작들은 전부 useCallback([]) 이라 처음 만들어진 뒤 바뀌지 않는다.
    // 그래서 여기 적힌 상태 조각들만 이 값을 다시 만든다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state.ui,
      state.session,
      state.conversations,
      state.conversationsLoading,
      state.conversationsError,
      state.activeConversationId,
    ],
  );

  return (
    <StoreContext.Provider value={value}>
      <ActiveConversationContext.Provider value={active}>{children}</ActiveConversationContext.Provider>
    </StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error("useStore must be used within a StoreProvider");
  return value;
}

/**
 * 열려 있는 대화를 읽는다. 이걸 부르는 컴포넌트는 답변이 흘러나오는 동안
 * 토큰마다 다시 그려진다 — 메시지를 그리는 쪽만 불러야 한다.
 */
export function useActiveConversation(): ActiveConversationValue {
  const value = useContext(ActiveConversationContext);
  if (!value) throw new Error("useActiveConversation must be used within a StoreProvider");
  return value;
}
