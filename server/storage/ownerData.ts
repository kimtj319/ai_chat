import fs from "node:fs/promises";
import { ownerDir } from "./paths.js";
import { isValidId } from "./paths.js";
import { listDocuments } from "./documentStore.js";
import { removeModelOwnersOf } from "./modelOwners.js";
import { ragConfigured, removeDocument, removeOwnerKey } from "../rag/engineIndex.js";

/**
 * Most of what one account owns lives under {DATA_DIR}/owners/{id} — its
 * conversations, attachments, documents, keys and schedules. This removes that
 * tree, plus the two records outside it that are keyed by the id: the indexed
 * document chunks and the model endpoints it registered (model-owners.json).
 * NOT handled here, still keyed by the bare id: MCP servers it registered
 * (`createdBy`), board posts (`authorId`) and its conversation shares.
 *
 * It is the one place in this codebase that deletes someone's history on
 * purpose, and it is a deliberate departure from the rule stated in
 * attachmentStore.ts ("orphaned-but-unreachable data is left on disk"). The
 * reason is that an owner directory is addressed by the account id alone: leave
 * it behind when the account goes, and the next person registered under that
 * id inherits a stranger's conversations. Orphaning is the safer choice for
 * data nobody can reach; this data would become reachable by the wrong person.
 */
export async function deleteOwnerData(ownerId: string): Promise<boolean> {
  // The id has already been normalised by the account store, but this builds a
  // recursive delete path, so it is checked again right where it is used.
  if (!isValidId(ownerId)) return false;
  // The search index is the one thing this account owns that does NOT live
  // under its directory, so removing the directory would leave it behind —
  // still searchable, and with the metadata that identified it now gone, no
  // longer removable by anything. It has to go first, while we can still read
  // which chunks were theirs.
  await removeIndexedDocuments(ownerId);
  await removeModelOwnership(ownerId);
  try {
    await fs.rm(ownerDir(ownerId), { recursive: true, force: true });
    return true;
  } catch (err) {
    console.warn(`[ownerData] could not remove the owner directory for "${ownerId}":`, err);
    return false;
  }
}

/**
 * Take this account's uploaded documents out of the search engine.
 *
 * Best-effort on purpose: a departing account must not be kept alive by an
 * engine that happens to be down. What is left behind in that case is chunks
 * under a key whose only account no longer exists — unreachable rather than
 * exposed — and the failure is logged loudly enough to clean up by hand.
 */
async function removeIndexedDocuments(ownerId: string): Promise<void> {
  if (!ragConfigured()) return;
  try {
    for (const doc of await listDocuments(ownerId)) {
      await removeDocument(doc.id, doc.chunks);
    }
    await removeOwnerKey(ownerId);
  } catch (err) {
    console.warn(`[ownerData] could not remove indexed documents for "${ownerId}":`, err);
  }
}

/**
 * Forget which model endpoints this account registered. Left behind, the next
 * account registered under the same id would be able to use and delete them
 * (routes/models.ts). Best-effort for the same reason as the index cleanup
 * above, and logged loudly, since what is left is exactly that hazard.
 */
async function removeModelOwnership(ownerId: string): Promise<void> {
  try {
    const removed = await removeModelOwnersOf(ownerId);
    if (removed > 0) console.log(`[ownerData] forgot ${removed} model endpoint registration(s) of "${ownerId}"`);
  } catch (err) {
    console.error(`[ownerData] could not forget the model endpoints registered by "${ownerId}":`, err);
  }
}
