import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { repoRoot } from "./common.mjs";

const root = join(repoRoot, "agent_tests");

test("each behavior description has a matching support folder and vice versa", async () => {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith("test_")) continue;
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const folder = await stat(join(root, entry.name.slice(0, -3)));
      assert(folder.isDirectory(), entry.name);
    } else if (entry.isDirectory()) {
      const description = await stat(join(root, `${entry.name}.md`));
      const instructions = await stat(join(root, entry.name, "README.md"));
      assert(description.isFile(), entry.name);
      assert(instructions.isFile(), entry.name);
    }
  }
});

test("shell entry points reference existing setup, cleanup and runner files after relocation", async () => {
  for (const directory of await readdir(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    for (const name of await readdir(join(root, directory.name))) {
      if (!name.endsWith(".sh")) continue;
      const script = await readFile(join(root, directory.name, name), "utf8");
      for (const match of script.matchAll(/agent_tests\/[\w/-]+\.(?:mjs|sh)/gu)) {
        const target = await stat(join(repoRoot, match[0]));
        assert(target.isFile(), `${directory.name}/${name}: ${match[0]}`);
      }
    }
  }
});
