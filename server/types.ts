// Shared types for the API contract. Keep in sync with the frontend contract —
// field names here are load-bearing (the frontend is built against them).
//
// This file is a barrel: the types live in types/*.ts by domain, and the
// settings (the only runtime part) in settings.ts. Import from here.

export * from "./settings.js";
export * from "./types/conversation.js";
export * from "./types/auth.js";
export * from "./types/mcp.js";
export * from "./types/rag.js";
export * from "./types/board.js";
