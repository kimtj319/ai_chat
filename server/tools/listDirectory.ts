import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "./types.js";
import { config } from "../config.js";
import { resolveInsideRoot } from "./fsRoot.js";

export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description:
    "List entries in a directory under the server's configured filesystem root. The path is resolved " +
    "(following symlinks) and checked to still be inside that root.",
  category: "filesystem",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path relative to the tool filesystem root. Defaults to the root itself.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(args: { path?: string }) {
    const real = await resolveInsideRoot(config.toolFsRoot, args?.path ?? ".");
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new Error("Not a directory");
    const entries = await fs.readdir(real, { withFileTypes: true });
    const items = await Promise.all(
      entries.slice(0, 500).map(async (entry) => {
        const entryPath = path.join(real, entry.name);
        let size: number | null = null;
        try {
          const s = await fs.stat(entryPath);
          size = s.isFile() ? s.size : null;
        } catch {
          // broken symlink or race with a concurrent delete — omit size rather than fail the whole listing
        }
        return {
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
          size,
        };
      }),
    );
    const realRoot = await fs.realpath(config.toolFsRoot);
    return { path: path.relative(realRoot, real) || ".", entries: items };
  },
};
