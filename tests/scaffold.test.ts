import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { VAULT_SCAFFOLD } from "../src/lib/scaffold";
import { ensureVault } from "../src/lib/storage";
import type { AppConfig } from "../src/lib/types";

const cfg: AppConfig = { basisPfad: "/mock-vault", semester: "Sem01", icalUrl: "https://example.test/private-feed", refreshHours: 12, lastRefresh: null };
const entries = VAULT_SCAFFOLD.map((file) => ({ name: file.path.join("/"), content: file.content }));
const scaffoldPaths = new Set(entries.map((entry) => entry.name));
const links = entries.flatMap((entry) => [...entry.content.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
  .map(([, target]) => target)
  .filter((target) => !/^https?:/.test(target))
  .map((target) => ({
    name: `${entry.name} -> ${target}`,
    resolved: decodeURIComponent(new URL(target, `file:///${entry.name}`).pathname.slice(1)),
  })));
let files: Map<string, string>;
let unreadable: Set<string>;

beforeEach(() => {
  files = new Map();
  unreadable = new Set();
  vi.stubGlobal("window", {});
  mockIPC((command, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    const path = args.path as string;
    switch (command) {
      case "plugin:path|join": return (args.paths as string[]).join("/");
      case "read_text_file":
        if (unreadable.has(path)) throw "Zugriff verweigert";
        return files.get(path) ?? null;
      case "save_text_file":
        if ((files.get(path) ?? null) !== args.expected) throw "CONFLICT";
        files.set(path, args.content as string);
        return;
      case "ensure_dir": return;
      default: throw new Error(`Unexpected IPC command: ${command}`);
    }
  });
});

afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
});

describe("ensureVault scaffold", () => {
  it.each(entries)("creates $name in a new vault", async ({ name, content }) => {
    await ensureVault(cfg, []);

    expect(files.get(`/mock-vault/${name}`)).toBe(content);
  });

  it("lets CLAUDE.md import the shared AGENTS.md", async () => {
    await ensureVault(cfg, []);

    expect(files.get("/mock-vault/CLAUDE.md")).toBe("@AGENTS.md\n");
  });

  it("builds the dashboard from Bases views instead of Dataview", async () => {
    await ensureVault(cfg, []);

    const readme = files.get("/mock-vault/README.md")!;
    expect(readme).toContain("![[Termine.base#Vorbereiten]]");
    expect(readme).not.toContain("```dataview");
  });

  it("skips a scaffold path the vault guard rejects and still finishes the sync", async () => {
    unreadable.add("/mock-vault/CLAUDE.md");

    await ensureVault(cfg, []);

    expect([files.has("/mock-vault/CLAUDE.md"), files.get("/mock-vault/AGENTS.md")]).toEqual([false, VAULT_SCAFFOLD[0].content]);
  });

  it("never overwrites files the user already has", async () => {
    const own = "# My own agent rules\n";
    files.set("/mock-vault/AGENTS.md", own);
    files.set("/mock-vault/00-system/templates/agent/assignment.md", own);

    await ensureVault(cfg, []);
    await ensureVault(cfg, []);

    expect([files.get("/mock-vault/AGENTS.md"), files.get("/mock-vault/00-system/templates/agent/assignment.md")]).toEqual([own, own]);
  });
});

describe("VAULT_SCAFFOLD content", () => {
  it.each(entries.filter((entry) => entry.name.endsWith(".json")))("ships valid JSON in $name", ({ content }) => {
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it.each(entries.filter((entry) => entry.name.endsWith(".base")))("ships a Bases file with views in $name", ({ content }) => {
    expect(parse(content)).toHaveProperty("views");
  });

  it.each(entries.filter((entry) => entry.name.endsWith(".base")))("keeps the template folder out of $name", ({ content }) => {
    expect(parse(content).filters.and).toContainEqual({ not: ['file.inFolder("00-system")'] });
  });

  it.each(links)("resolves the relative link $name inside the scaffold", ({ resolved }) => {
    expect(scaffoldPaths).toContain(resolved);
  });
});
