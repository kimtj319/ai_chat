import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

/**
 * The conversation store is off limits to the filesystem tools, whatever
 * TOOL_FS_ROOT happens to be.
 *
 * This is not theoretical. Shipped defaults put DATA_DIR inside the tool root
 * (TOOL_FS_ROOT unset -> process.cwd(), DATA_DIR=./data), and with them the
 * production tools enumerated every session directory and read conversation
 * JSON belonging to three different sessions. The app has no authentication,
 * so any visitor could have had the model read anyone else's chats.
 * Configuration alone is too easy to get wrong, so the ban lives in the one
 * chokepoint both tools already share.
 */
let deniedRootCache: string | undefined;
async function deniedRoot(): Promise<string> {
  if (deniedRootCache === undefined) {
    try {
      deniedRootCache = await fs.realpath(config.dataDir);
    } catch {
      // Not created yet — resolving the configured path still contains it.
      deniedRootCache = path.resolve(config.dataDir);
    }
  }
  return deniedRootCache;
}

/** True when any path segment below `root` begins with a dot. */
function hasHiddenSegment(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return false;
  return rel.split(path.sep).some((segment) => segment.startsWith("."));
}

/** True when `target` is the denied root itself or anything beneath it. */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve `relativePath` against `root`, following symlinks, and verify the
 * REAL path still lives inside the REAL root — after resolution, so `..`
 * segments and symlinks can't escape it. Shared by read_text_file and
 * list_directory since it's security-critical and must not diverge between
 * the two call sites.
 */
export async function resolveInsideRoot(root: string, relativePath: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const candidate = path.resolve(realRoot, relativePath || ".");
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No such file or directory: ${relativePath}`);
    }
    throw err;
  }
  const relation = path.relative(realRoot, real);
  if (relation !== "" && (relation.startsWith("..") || path.isAbsolute(relation))) {
    throw new Error("Path escapes the allowed root directory");
  }
  // Checked after symlink resolution, so a link pointing into the store is
  // refused too, not just a literal ./data/... path.
  if (isInside(await deniedRoot(), real)) {
    throw new Error("Path is inside the conversation store and cannot be read");
  }
  // TOOL_FS_ROOT defaults to the application directory, and that directory
  // holds .env — the API keys, and until recently the admin password. Any
  // approved account could ask the model to read it. Dotfiles are where a
  // deployment keeps its secrets and almost never what a reader legitimately
  // wants, so the whole class is refused rather than a list of names that
  // would need updating every time one is added.
  if (hasHiddenSegment(realRoot, real)) {
    throw new Error("Hidden files and directories cannot be read");
  }
  return real;
}
