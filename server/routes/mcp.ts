import { Router, type Response } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { assertRegisterableUrl, probeMcpServer, type McpToolDescriptor } from "../mcp/client.js";
import { DISCOVERY_BUDGET_MS, ensureFresh, invalidate, prime, refresh, scheduleRefresh, snapshot } from "../mcp/discovery.js";
import {
  adoptionCountFor,
  countAdoptions,
  forgetServerEverywhere,
  getCredential,
  readOwnerPrefs,
  setAdoption,
  setCredential,
  setHidden,
  type AdoptionCounts,
} from "../mcp/ownerPrefs.js";
import { toolSummaries } from "../mcp/toolAdapter.js";
import {
  clampTimeoutMs,
  createServer,
  deleteServer,
  getServer,
  listServers,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  MAX_SLUG_CHARS,
  MIN_SLUG_CHARS,
  normalizeAuthMode,
  normalizeDescription,
  normalizeHeaderName,
  normalizeName,
  normalizeOptionalText,
  normalizeServerId,
  normalizeSlug,
  setServerStatus,
  updateServer,
} from "../mcp/registryStore.js";
import { listUsers } from "../storage/userStore.js";
import type { McpErrorCode, McpServerRecord, McpServerSummary, OwnerMcpPrefs } from "../types.js";

/**
 * The MCP registry API.
 *
 * WHO MAY DO WHAT. Reading the registry is open to every signed-in account,
 * because the registry is how someone decides whether to adopt a server.
 * Editing or deleting a record is the REGISTRANT or an admin. Disabling one for
 * everybody is an admin, and lives under /api/admin/mcp — mounted the way
 * routes/admin.ts mounts its own: one `use()` with requireAdmin in front of the
 * whole prefix, so a route added later cannot forget the guard.
 *
 * WHAT NEVER LEAVES. A credential. Not on create, not on read, not on probe,
 * not in an error. `hasCredential` is a boolean, and it describes the CALLING
 * owner only.
 */

export const mcpRouter = Router();

function fail(res: Response, status: number, code: McpErrorCode, error: string): void {
  res.status(status).json({ error, code });
}

const CREDENTIAL_MAX_CHARS = 4096;

/**
 * The refusals name the rule that failed, not just the field: the form is the
 * only place these rules are written down for the person filling it in.
 */
const SLUG_RULE =
  `식별자(slug)는 영소문자와 숫자를 하이픈(-)으로 이은 ${MIN_SLUG_CHARS}~${MAX_SLUG_CHARS}자여야 합니다. ` +
  "밑줄(_)은 사용할 수 없습니다 — 도구 이름 mcp__{slug}__{도구}의 구분자와 겹칩니다.";
const DESCRIPTION_RULE = `설명은 필수이며 ${MAX_DESCRIPTION_CHARS}자 이내여야 합니다.`;

/** The registrant, or an admin. Nobody else may change a record. */
function mayEdit(server: McpServerRecord, userId: string, isAdmin: boolean): boolean {
  return isAdmin || server.createdBy === userId;
}

/**
 * The URL WITHOUT ITS QUERY, because a key can live there: the Alpha Vantage
 * builtin carries `?apikey=` since that server accepts no auth header, and this
 * summary goes to every signed-in account. The host is unaffected.
 */
function publicUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = "";
    return url.toString();
  } catch {
    return raw.split("?")[0]!;
  }
}

function summarize(
  server: McpServerRecord,
  prefs: OwnerMcpPrefs,
  counts: AdoptionCounts,
  totalAccounts: number,
  tools: McpToolDescriptor[],
): McpServerSummary {
  const url = publicUrl(server.url);
  let host: string;
  try {
    host = new URL(server.url).host;
  } catch {
    host = url;
  }
  const state = snapshot(server.id);
  return {
    id: server.id,
    name: server.name,
    slug: server.slug,
    description: server.description,
    url,
    host,
    transport: server.transport,
    origin: server.origin,
    status: server.status,
    createdBy: server.createdBy,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    adoptedCount: adoptionCountFor(server, counts, totalAccounts),
    authMode: server.authMode,
    ...(server.authHeaderName ? { authHeaderName: server.authHeaderName } : {}),
    requiresCredential: server.authMode === "header",
    hasCredential: Boolean(prefs.credentials[server.id]),
    health: state.health,
    // The same adapter the prompt uses, so the list never advertises a tool the
    // model was not actually given (a dropped name, a schema over budget).
    tools: toolSummaries(server, tools),
    ...(server.disabledReason ? { disabledReason: server.disabledReason } : {}),
  };
}

/** Everything a summary needs that is the same for every server in one response. */
async function summaryContext(ownerId: string): Promise<{ prefs: OwnerMcpPrefs; counts: AdoptionCounts; totalAccounts: number }> {
  const [prefs, counts, users] = await Promise.all([readOwnerPrefs(ownerId), countAdoptions(), listUsers()]);
  return { prefs, counts, totalAccounts: users.length };
}

/**
 * GET /api/mcp/servers — the whole registry, plus this owner's own switches.
 *
 * A stale entry only SCHEDULES a refresh: the response is answered from cache
 * so that opening the page never waits on someone else's server.
 */
mcpRouter.get("/mcp/servers", async (req, res, next) => {
  try {
    const servers = await listServers();
    const { prefs, counts, totalAccounts } = await summaryContext(req.ownerId);
    const summaries: McpServerSummary[] = [];
    for (const server of servers) {
      const state = snapshot(server.id);
      if (server.status === "active" && state.stale) scheduleRefresh(server, prefs.credentials[server.id]);
      summaries.push(summarize(server, prefs, counts, totalAccounts, state.tools));
    }
    res.json({ servers: summaries, adopted: prefs.adopted, hidden: prefs.hidden });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/mcp/servers — register a server, but only one that answers.
 *
 * The probe is synchronous and part of the contract: a record that was never
 * reached is a record whose tools never appear, and the person who added it
 * would have no way to tell that from "it is loading". The whole probe shares
 * ONE ~10s budget, the same one discovery uses.
 *
 * The new server is adopted BY THE REGISTRANT ONLY. Publishing is not switching
 * on — nobody else's file is touched.
 */
mcpRouter.post("/mcp/servers", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = normalizeName(body.name);
    if (!name) return fail(res, 400, "invalid_input", `이름을 입력해 주세요 (${MAX_NAME_CHARS}자 이내).`);
    const slug = normalizeSlug(body.slug);
    if (!slug) return fail(res, 400, "invalid_input", SLUG_RULE);
    const description = normalizeDescription(body.description);
    if (!description) return fail(res, 400, "invalid_input", DESCRIPTION_RULE);
    const authMode = normalizeAuthMode(body.authMode ?? "none");
    if (!authMode) return fail(res, 400, "invalid_input", "인증 방식은 none 또는 header여야 합니다.");
    let authHeaderName: string | undefined;
    if (authMode === "header") {
      const headerName = normalizeHeaderName(body.authHeaderName);
      if (!headerName) return fail(res, 400, "invalid_input", "인증 헤더 이름이 올바르지 않습니다.");
      authHeaderName = headerName;
    }
    const credential = typeof body.credential === "string" ? body.credential.trim() : "";
    if (credential.length > CREDENTIAL_MAX_CHARS) {
      return fail(res, 400, "invalid_input", "인증 값이 너무 깁니다.");
    }
    if (authMode === "header" && !credential) {
      return fail(res, 400, "invalid_input", "인증 방식이 header이면 인증 값을 함께 보내야 합니다.");
    }

    let url: URL;
    try {
      url = await assertRegisterableUrl(typeof body.url === "string" ? body.url.trim() : "");
    } catch (err) {
      return fail(res, 400, "invalid_input", err instanceof Error ? err.message : "주소를 확인할 수 없습니다.");
    }

    const probe = await probeMcpServer(
      {
        url: url.toString(),
        ...(authHeaderName ? { authHeaderName } : {}),
        ...(credential ? { credential } : {}),
      },
      AbortSignal.timeout(DISCOVERY_BUDGET_MS),
    );
    if (!probe.ok) {
      const stage =
        probe.stage === "tools/list"
          ? "도구 목록 조회(tools/list)"
          : probe.stage === "initialize"
            ? "연결 및 초기화(initialize)"
            : "주소 확인";
      return fail(res, 400, "probe_failed", `${stage}에 실패하여 등록하지 않았습니다: ${probe.error ?? "알 수 없는 오류"}`);
    }

    const created = await createServer({
      name,
      slug,
      description,
      url: url.toString(),
      authMode,
      ...(authHeaderName ? { authHeaderName } : {}),
      ...(typeof body.timeoutMs === "number" ? { timeoutMs: clampTimeoutMs(body.timeoutMs) } : {}),
      createdBy: req.ownerId,
    });
    if (!created.ok) {
      return created.code === "duplicate_slug"
        ? fail(res, 409, "duplicate_slug", "같은 식별자(slug)의 MCP 서버가 이미 있습니다.")
        : fail(res, 409, "duplicate_name", "같은 이름의 MCP 서버가 이미 있습니다.");
    }

    if (credential) await setCredential(req.ownerId, created.server.id, credential);
    await setAdoption(req.ownerId, created.server, true);
    // The probe that just ran IS the discovery result; probing again to learn
    // the same thing would cost another round trip for nothing.
    prime(created.server, probe.tools);

    console.log(
      `[mcp] ${req.ownerId} registered "${created.server.name}" (${created.server.slug}) ` +
        `${url.host} tools=${probe.tools.length} ${probe.latencyMs}ms`,
    );
    const { prefs, counts, totalAccounts } = await summaryContext(req.ownerId);
    res.status(201).json({ server: summarize(created.server, prefs, counts, totalAccounts, probe.tools) });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/mcp/servers/:id — registrant or admin.
 *
 * `slug` is refused rather than ignored: it is inside the tool name stored in
 * every conversation that ever used this server, so accepting it silently would
 * rewrite what those transcripts say happened.
 */
mcpRouter.patch("/mcp/servers/:id", async (req, res, next) => {
  try {
    const id = normalizeServerId(req.params.id);
    const server = id ? await getServer(id) : null;
    if (!server || !id) return fail(res, 404, "not_found", "존재하지 않는 MCP 서버입니다.");
    if (!mayEdit(server, req.ownerId, req.user?.role === "admin")) {
      return fail(res, 403, "forbidden", "등록한 사용자 또는 관리자만 수정할 수 있습니다.");
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.slug !== undefined && body.slug !== server.slug) {
      return fail(res, 400, "slug_immutable", "식별자(slug)는 변경할 수 없습니다.");
    }

    const patch: Parameters<typeof updateServer>[1] = {};
    if (body.name !== undefined) {
      const name = normalizeName(body.name);
      if (!name) return fail(res, 400, "invalid_input", `이름을 입력해 주세요 (${MAX_NAME_CHARS}자 이내).`);
      patch.name = name;
    }
    if (body.description !== undefined) {
      const description = normalizeDescription(body.description);
      if (!description) return fail(res, 400, "invalid_input", DESCRIPTION_RULE);
      patch.description = description;
    }
    // A builtin's address comes from code and .env, and the only version a
    // client has ever been shown is the one summarize() stripped the query
    // from. Echoing that back is what an edit form does with every field, so
    // honouring it would quietly replace Alpha Vantage's key-bearing URL with a
    // keyless one and leave the server answering nothing. Ignored rather than
    // refused (the treatment `slug` gets) so that editing a builtin's name or
    // description still works.
    if (body.url !== undefined && server.origin !== "builtin") {
      try {
        patch.url = (await assertRegisterableUrl(typeof body.url === "string" ? body.url.trim() : "")).toString();
      } catch (err) {
        return fail(res, 400, "invalid_input", err instanceof Error ? err.message : "주소를 확인할 수 없습니다.");
      }
    }
    if (body.authMode !== undefined) {
      const authMode = normalizeAuthMode(body.authMode);
      if (!authMode) return fail(res, 400, "invalid_input", "인증 방식은 none 또는 header여야 합니다.");
      patch.authMode = authMode;
    }
    if (body.authHeaderName !== undefined) {
      if (body.authHeaderName === null || body.authHeaderName === "") {
        patch.authHeaderName = null;
      } else {
        const headerName = normalizeHeaderName(body.authHeaderName);
        if (!headerName) return fail(res, 400, "invalid_input", "인증 헤더 이름이 올바르지 않습니다.");
        patch.authHeaderName = headerName;
      }
    }
    if (body.timeoutMs !== undefined) patch.timeoutMs = clampTimeoutMs(body.timeoutMs);
    const effectiveAuthMode = patch.authMode ?? server.authMode;
    const effectiveHeader = patch.authHeaderName === undefined ? server.authHeaderName : patch.authHeaderName;
    if (effectiveAuthMode === "header" && !effectiveHeader) {
      return fail(res, 400, "invalid_input", "인증 방식이 header이면 인증 헤더 이름이 필요합니다.");
    }

    // The edit form carries the credential field too, and a blank one means
    // "keep what is stored" — so only a non-empty value writes, and it writes to
    // the CALLING owner's file, never to the shared record.
    const credential = typeof body.credential === "string" ? body.credential.trim() : "";
    if (credential.length > CREDENTIAL_MAX_CHARS) {
      return fail(res, 400, "invalid_input", "인증 값이 너무 깁니다.");
    }

    const updated = await updateServer(id, patch);
    if (!updated.ok) {
      return updated.code === "duplicate_name"
        ? fail(res, 409, "duplicate_name", "같은 이름의 MCP 서버가 이미 있습니다.")
        : fail(res, 404, "not_found", "존재하지 않는 MCP 서버입니다.");
    }
    if (credential) await setCredential(req.ownerId, id, credential);
    // The address, the auth or the credential changed, so the cached tool list
    // may describe a different server entirely. Discard it rather than serve it.
    if (credential || patch.url !== undefined || patch.authMode !== undefined || patch.authHeaderName !== undefined) {
      invalidate(id);
    }
    console.log(`[mcp] ${req.ownerId} updated "${updated.server.name}" (${updated.server.slug})`);
    const { prefs, counts, totalAccounts } = await summaryContext(req.ownerId);
    res.json({ server: summarize(updated.server, prefs, counts, totalAccounts, snapshot(id).tools) });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/mcp/servers/:id.
 *
 * The registrant may not delete a server other people are relying on — they
 * get 409 with the count, and can ask an admin. An admin deletes it anyway, and
 * the record is then removed from every owner's file: an adoption or a
 * credential for an id nobody can see any more is a secret on disk with no
 * owner.
 */
mcpRouter.delete("/mcp/servers/:id", async (req, res, next) => {
  try {
    const id = normalizeServerId(req.params.id);
    const server = id ? await getServer(id) : null;
    if (!server || !id) return fail(res, 404, "not_found", "존재하지 않는 MCP 서버입니다.");
    const isAdmin = req.user?.role === "admin";
    if (!mayEdit(server, req.ownerId, isAdmin)) {
      return fail(res, 403, "forbidden", "등록한 사용자 또는 관리자만 삭제할 수 있습니다.");
    }
    const [counts, prefs, users] = await Promise.all([countAdoptions(), readOwnerPrefs(req.ownerId), listUsers()]);
    const total = adoptionCountFor(server, counts, users.length);
    const selfAdopted = server.origin === "builtin" ? !prefs.hidden.includes(id) : prefs.adopted.includes(id);
    const others = Math.max(total - (selfAdopted ? 1 : 0), 0);
    if (!isAdmin && others > 0) {
      return res.status(409).json({
        error: "in_use",
        code: "in_use",
        adoptedCount: others,
        message: `다른 사용자 ${others}명이 사용 중이라 삭제할 수 없습니다. 관리자에게 비활성화를 요청해 주세요.`,
      });
    }
    const removed = await deleteServer(id);
    if (!removed) return fail(res, 404, "not_found", "존재하지 않는 MCP 서버입니다.");
    invalidate(id);
    const touched = await forgetServerEverywhere(id);
    // Again, after the owner sweep: a refresh that was already in flight when
    // the record went can land in between and re-create the entry under an id
    // nothing will ever read again.
    invalidate(id);
    console.log(`[mcp] ${req.ownerId} deleted "${server.name}" (${server.slug}); cleaned ${touched} owner file(s)`);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/mcp/servers/:id/adoption { adopted } — this owner's "담기", nobody
 * else's. Only meaningful for a server someone else registered; harmless
 * no-op data for a builtin or your own server, since membership for those
 * never checks `adopted` (see effectiveServers / isMcpVisible).
 */
mcpRouter.put("/mcp/servers/:id/adoption", async (req, res, next) => {
  try {
    const id = normalizeServerId(req.params.id);
    const server = id ? await getServer(id) : null;
    if (!server) return fail(res, 404, "not_found", "존재하지 않는 MCP 서버입니다.");
    const adopted = (req.body ?? {}).adopted;
    if (typeof adopted !== "boolean") return fail(res, 400, "invalid_input", "adopted는 true 또는 false여야 합니다.");
    const prefs = await setAdoption(req.ownerId, server, adopted);
    res.json({ adopted: prefs.adopted });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/mcp/servers/:id/hidden { hidden } — this owner's switch, nobody
 * else's. The one control behind the library card's on/off toggle: it works
 * the same for a builtin, something this owner registered or something they
 * adopted, because tool availability (effectiveServers) checks the same
 * `hidden` list regardless of origin.
 */
mcpRouter.put("/mcp/servers/:id/hidden", async (req, res, next) => {
  try {
    const id = normalizeServerId(req.params.id);
    const server = id ? await getServer(id) : null;
    if (!server || !id) return fail(res, 404, "not_found", "존재하지 않는 MCP 서버입니다.");
    const hidden = (req.body ?? {}).hidden;
    if (typeof hidden !== "boolean") return fail(res, 400, "invalid_input", "hidden은 true 또는 false여야 합니다.");
    const prefs = await setHidden(req.ownerId, id, hidden);
    res.json({ hidden: prefs.hidden });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/mcp/servers/:id/credential { credential } — write-only. null clears
 * it. The response says whether one is now stored and never what it is.
 */
mcpRouter.put("/mcp/servers/:id/credential", async (req, res, next) => {
  try {
    const id = normalizeServerId(req.params.id);
    const server = id ? await getServer(id) : null;
    if (!server || !id) return fail(res, 404, "not_found", "존재하지 않는 MCP 서버입니다.");
    const raw = (req.body ?? {}).credential;
    if (raw !== null && typeof raw !== "string") {
      return fail(res, 400, "invalid_input", "credential은 문자열 또는 null이어야 합니다.");
    }
    if (typeof raw === "string" && raw.length > CREDENTIAL_MAX_CHARS) {
      return fail(res, 400, "invalid_input", "인증 값이 너무 깁니다.");
    }
    const hasCredential = await setCredential(req.ownerId, id, raw === null ? null : raw.trim());
    // The cached tool list may have been discovered with the old credential.
    invalidate(id);
    console.log(`[mcp] ${req.ownerId} ${hasCredential ? "set" : "cleared"} the credential for ${server.slug}`);
    res.json({ hasCredential });
  } catch (err) {
    next(err);
  }
});

/** POST /api/mcp/servers/:id/probe — discovery now, with this owner's credential. */
mcpRouter.post("/mcp/servers/:id/probe", async (req, res, next) => {
  try {
    const id = normalizeServerId(req.params.id);
    const server = id ? await getServer(id) : null;
    if (!server || !id) return fail(res, 404, "not_found", "존재하지 않는 MCP 서버입니다.");
    const credential = await getCredential(req.ownerId, id);
    const state = await refresh(server, credential);
    res.json({ health: state.health, tools: toolSummaries(server, state.tools) });
  } catch (err) {
    next(err);
  }
});

// Everything under /api/admin/mcp is admin-only, guarded once for the whole
// prefix — the shape routes/admin.ts uses, so a route added below cannot forget
// the check. requireActiveUser (app.ts) has already established the account.
mcpRouter.use("/admin/mcp", requireAdmin);

/**
 * PUT /api/admin/mcp/servers/:id/status { disabled, reason? }.
 *
 * The admin's alternative to deleting something other people adopted: a
 * disabled server contributes no tools to anyone and keeps every adoption and
 * credential intact, so re-enabling it puts everything back.
 */
mcpRouter.put("/admin/mcp/servers/:id/status", async (req, res, next) => {
  try {
    const id = normalizeServerId(req.params.id);
    if (!id) return fail(res, 404, "not_found", "존재하지 않는 MCP 서버입니다.");
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.disabled !== "boolean") {
      return fail(res, 400, "invalid_input", "disabled는 true 또는 false여야 합니다.");
    }
    // Optional, unlike a server's description: an admin disabling something in a
    // hurry should not be stopped by a missing explanation.
    const reason = normalizeOptionalText(body.reason ?? "", MAX_DESCRIPTION_CHARS);
    if (reason === null) return fail(res, 400, "invalid_input", `사유는 ${MAX_DESCRIPTION_CHARS}자 이내여야 합니다.`);
    const updated = await setServerStatus(id, body.disabled, req.user!.id, reason || undefined);
    if (!updated) return fail(res, 404, "not_found", "존재하지 않는 MCP 서버입니다.");
    invalidate(id);
    if (!body.disabled) void ensureFresh(updated).catch(() => undefined);
    console.log(
      `[mcp] admin ${req.user!.id} ${body.disabled ? "disabled" : "enabled"} "${updated.name}" (${updated.slug})` +
        (reason ? ` reason="${reason}"` : ""),
    );
    const { prefs, counts, totalAccounts } = await summaryContext(req.ownerId);
    res.json({ server: summarize(updated, prefs, counts, totalAccounts, snapshot(id).tools) });
  } catch (err) {
    next(err);
  }
});
