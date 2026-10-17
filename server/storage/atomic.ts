import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/** Read + JSON.parse a file, returning null if it doesn't exist. */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  const raw = await fs.readFile(filePath, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

/**
 * Write JSON atomically: write to a unique temp file in the same directory,
 * then rename over the target. A crash mid-write leaves the temp file, never
 * a truncated target file, and `fs.rename` is atomic on the same filesystem.
 */
export async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

/** A directory's entries, or [] when it does not exist. Any other error still throws. */
export async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Remove a file; false when it was already gone. Any other error still throws. */
export async function unlinkIfPresent(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** The same discipline for raw bytes (attachment payloads), not just JSON. */
export async function writeFileAtomic(filePath: string, data: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmpPath, data);
  await fs.rename(tmpPath, filePath);
}
