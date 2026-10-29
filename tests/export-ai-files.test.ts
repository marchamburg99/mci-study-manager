/// <reference types="node" />
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VAULT_SCAFFOLD } from "../src/lib/scaffold";

let target: string;

beforeAll(async () => {
  target = path.join(await mkdtemp(path.join(tmpdir(), "ai-files-")), "out");
  await promisify(execFile)(process.execPath, ["scripts/export-ai-files.mjs", target]);
});

afterAll(async () => {
  await rm(path.dirname(target), { recursive: true, force: true });
});

describe("export-ai-files", () => {
  it.each(VAULT_SCAFFOLD.map((file) => ({ name: file.path.join("/"), content: file.content })))(
    "exports $name exactly as the app scaffolds it", async ({ name, content }) => {
      expect(await readFile(path.join(target, name), "utf8")).toBe(content);
    });

  it("adds only a German readme besides the scaffold files", async () => {
    const files = (await readdir(target, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile()).map((entry) => path.relative(target, path.join(entry.parentPath, entry.name))).sort();

    expect(files).toEqual([...VAULT_SCAFFOLD.map((file) => file.path.join("/")), "LIESMICH.txt"].sort());
  });
});
