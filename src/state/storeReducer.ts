import type { Conversation, ConversationSummary, Session } from "../api/types";
import { loadUiPreferences } from "./storage";
import type { ClientChatMessage, UiPreferences } from "./types";

/** The active conversation, with client-side streaming state on its messages. */
export interface ActiveConversation extends Omit<Conversation, "messages"> {
  messages: ClientChatMessage[];
}

export interface State {
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

export type Action =
  | { type: "SET_UI"; patch: Partial<UiPreferences> }
  | { type: "SET_SESSION"; session: Session }
  | { type: "SET_CONVERSATIONS_LOADING" }
  | { type: "SET_CONVERSATIONS"; conversations: ConversationSummary[] }
  | { type: "SET_CONVERSATIONS_ERROR"; error: string }
  | { type: "REMOVE_CONVERSATION_SUMMARY"; id: string }
  | { type: "SET_ACTIVE_ID"; id: string | null }
  | { type: "SET_ACTIVE_LOADING" }
  | { type: "SET_ACTIVE_CONVERSATION"; conversation: Conversation }
  | { type: "SET_ACTIVE_ERROR"; id: string; error: string }
  | { type: "PATCH_ACTIVE_META"; conversationId: string; patch: Partial<Conversation> }
  | { type: "SET_ACTIVE_MESSAGES"; conversationId: string; messages: ClientChatMessage[] }
  /** id 가 matchIds 중 하나인 메시지를 바꾸고, 없으면 덧붙인다. */
  | { type: "UPSERT_ACTIVE_MESSAGE"; conversationId: string; matchIds: string[]; message: ClientChatMessage };

export function reducer(state: State, action: Action): State {
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
        // 불러오던 대화를 떠나면(지우거나 다른 대화로) 그 로딩은 이제 아무것도
        // 채우지 않는다 — SET_ACTIVE_CONVERSATION 이 다른 id 의 응답을 버리니까.
        activeConversationLoading: false,
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
      // 늦게 실패한 이전 대화의 오류가 지금 여는 대화에 붙지 않게.
      if (action.id !== state.activeConversationId) return state;
      return { ...state, activeConversationLoading: false, activeConversationError: action.error };

    case "PATCH_ACTIVE_META": {
      // PATCH 응답은 대화를 옮긴 뒤에 올 수 있다. 메시지 동작들과 같은 이유로 id 를 본다.
      if (!state.activeConversation || state.activeConversation.id !== action.conversationId) return state;
      return { ...state, activeConversation: { ...state.activeConversation, ...action.patch } };
    }

    case "SET_ACTIVE_MESSAGES": {
      if (!state.activeConversation || state.activeConversation.id !== action.conversationId) return state;
      return { ...state, activeConversation: { ...state.activeConversation, messages: action.messages } };
    }

    case "UPSERT_ACTIVE_MESSAGE": {
      // 흐르는 답의 자리. 답이 흐르는 동안 다른 대화에 갔다 오면 서버에서 다시 불러온
      // 대화에는 그 자리가 없다 — 그때는 새로 붙여야 조각과 done 이 버려지지 않는다.
      // done 의 진짜 id 도 함께 찾는다: 다시 불러온 대화가 이미 저장된 답을 들고 있으면
      // 그것을 바꿔 같은 답이 두 번 붙지 않는다.
      if (!state.activeConversation || state.activeConversation.id !== action.conversationId) return state;
      const messages = state.activeConversation.messages;
      const index = messages.findIndex((m) => action.matchIds.includes(m.id));
      return {
        ...state,
        activeConversation: {
          ...state.activeConversation,
          messages:
            index < 0
              ? [...messages, action.message]
              : messages.map((m, i) => (i === index ? action.message : m)).filter((m, i) => i === index || !action.matchIds.includes(m.id)),
        },
      };
    }

    default:
      return state;
  }
}

export function init(): State {
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
