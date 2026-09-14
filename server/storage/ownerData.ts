import fs from "node:fs/promises";
import { ownerDir } from "./paths.js";
import { isValidId } from "./paths.js";
import { listDocuments } from "./documentStore.js";
import { ragConfigured, removeDocument, removeOwnerKey } from "../rag/engineIndex.js";

/**
 * Everything one account owns lives under {DATA_DIR}/owners/{id} — its
 * conversations and every attachment inside them. This removes that tree.
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
