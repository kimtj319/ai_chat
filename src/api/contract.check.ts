/**
 * 서버와 프런트의 계약이 **같은지** 컴파일러에게 확인시킨다.
 *
 * 왜 필요한가: 이 저장소에는 같은 이름의 타입이 두 벌 있다 — server/types.ts 와
 * src/api/types.ts. 둘을 손으로 맞추고 있었고, 맞는지 보는 장치가 없었다.
 * 그래서 서버에서 필드 이름 하나를 바꾸면 **양쪽 다 컴파일되고** 런타임에
 * 깨진다. 이 저장소에서 조용히 틀릴 수 있는 거의 유일한 자리였다.
 *
 * 어떻게 확인하는가: 타입 수준의 대조다. `Expect<...>` 는 인자가 `true` 가
 * 아니면 **컴파일 오류**를 낸다 — 그게 이 파일의 전부이고, 값을 하나도 만들지
 * 않으므로 번들에는 아무것도 남지 않는다.
 *
 * 처음 쓴 판은 결과를 인터페이스 속성에 담았는데, 그러면 어긋난 자리가 `never`
 * 타입의 속성이 될 뿐 오류가 아니었다 — 일부러 틀린 대조를 넣어도 빌드가
 * 통과했다. 검사가 실패할 수 있는지 확인하지 않으면 이런 것이 남는다.
 *
 * 새 계약 타입을 더할 때: 아래에 `Expect<Mutual<...>>` 한 줄을 더한다.
 */
import type * as Server from "../../server/types";
import type * as Client from "./types";

/** A 를 B 에 넣을 수 있는가. */
type Assignable<A, B> = [A] extends [B] ? true : false;

/** 서로 넣을 수 있는가 — 한쪽에만 있는 필드가 있으면 false 가 된다. */
type Mutual<A, B> = Assignable<A, B> extends true ? (Assignable<B, A> extends true ? true : false) : false;

/**
 * 인자가 `true` 가 아니면 여기서 컴파일이 멈춘다.
 *
 * `T extends true` 로 좁히는 것이 핵심이다. `false` 는 `true` 에 대입되지 않아
 * 오류가 되고, 오류 메시지가 이 줄을 가리켜 **어느 타입이 어긋났는지** 바로 보인다.
 */
type Expect<T extends true> = T;

/* ------------------------------------------------------- 계약 대조 (한 줄에 하나) */

type _BoardPostStatus = Expect<Mutual<Server.BoardPostStatus, Client.BoardPostStatus>>;
type _BoardReply = Expect<Mutual<Server.BoardReply, Client.BoardReply>>;
type _BoardReplyView = Expect<Mutual<Server.BoardReplyView, Client.BoardReplyView>>;
type _BoardPostView = Expect<Mutual<Server.BoardPostView, Client.BoardPostView>>;
type _BoardPostSummary = Expect<Mutual<Server.BoardPostSummary, Client.BoardPostSummary>>;
type _AttachmentErrorCode = Expect<Mutual<Server.AttachmentErrorCode, Client.AttachmentErrorCode>>;
type _AuthErrorCode = Expect<Mutual<Server.AuthErrorCode, Client.AuthErrorCode>>;
type _Conversation = Expect<Mutual<Server.Conversation, Client.Conversation>>;
type _ConversationKind = Expect<Mutual<Server.ConversationKind, Client.ConversationKind>>;
type _ConversationSettings = Expect<Mutual<Server.ConversationSettings, Client.ConversationSettings>>;
type _ConversationSummary = Expect<Mutual<Server.ConversationSummary, Client.ConversationSummary>>;
type _McpAuthMode = Expect<Mutual<Server.McpAuthMode, Client.McpAuthMode>>;
type _McpHealth = Expect<Mutual<Server.McpHealth, Client.McpHealth>>;
type _McpHealthState = Expect<Mutual<Server.McpHealthState, Client.McpHealthState>>;
type _McpServerStatus = Expect<Mutual<Server.McpServerStatus, Client.McpServerStatus>>;
type _McpServerSummary = Expect<Mutual<Server.McpServerSummary, Client.McpServerSummary>>;
type _McpToolSummary = Expect<Mutual<Server.McpToolSummary, Client.McpToolSummary>>;
type _MessageAttachment = Expect<Mutual<Server.MessageAttachment, Client.MessageAttachment>>;
type _MessageEmbedding = Expect<Mutual<Server.MessageEmbedding, Client.MessageEmbedding>>;
type _MessageRole = Expect<Mutual<Server.MessageRole, Client.MessageRole>>;
type _MessageUsage = Expect<Mutual<Server.MessageUsage, Client.MessageUsage>>;
type _RagDocument = Expect<Mutual<Server.RagDocument, Client.RagDocument>>;
type _SharedRagDocument = Expect<Mutual<Server.SharedRagDocument, Client.SharedRagDocument>>;
type _RagDocumentScope = Expect<Mutual<Server.RagDocumentScope, Client.RagDocumentScope>>;
type _ReasoningLevel = Expect<Mutual<Server.ReasoningLevel, Client.ReasoningLevel>>;
type _ReasoningMode = Expect<Mutual<Server.ReasoningMode, Client.ReasoningMode>>;
type _UserRole = Expect<Mutual<Server.UserRole, Client.UserRole>>;

/**
 * 위의 타입 별칭들은 어디에도 쓰이지 않는다 — 쓰이지 않아도 컴파일러는 검사한다.
 * `noUnusedLocals` 가 타입 별칭까지는 보지 않으므로 그대로 두어도 되지만,
 * 이 파일이 무엇을 위한 것인지 남기기 위해 하나로 묶어 내보낸다.
 */
export type ContractChecked = [
  _AttachmentErrorCode,
  _BoardPostStatus,
  _BoardReply,
  _BoardReplyView,
  _BoardPostView,
  _BoardPostSummary,
  _AuthErrorCode,
  _Conversation,
  _ConversationKind,
  _ConversationSettings,
  _ConversationSummary,
  _McpAuthMode,
  _McpHealth,
  _McpHealthState,
  _McpServerStatus,
  _McpServerSummary,
  _McpToolSummary,
  _MessageAttachment,
  _MessageEmbedding,
  _MessageRole,
  _MessageUsage,
  _RagDocument,
  _RagDocumentScope,
  _SharedRagDocument,
  _ReasoningLevel,
  _ReasoningMode,
  _UserRole,
];
