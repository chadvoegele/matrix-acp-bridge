import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) {
    return;
  }
  try {
    await handle.close();
  } catch {
    // Preserve the original operation result.
  }
}

export async function unlinkQuietly(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
    // Temporary-file cleanup is best effort.
  }
}
