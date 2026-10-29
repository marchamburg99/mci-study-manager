import manifest from "../scaffold/vault/manifest.json";

const sources = import.meta.glob<string>(["../scaffold/vault/**/*", "!../scaffold/vault/manifest.json"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Vault files the app creates once and never overwrites: AI agent instructions,
 * agent work templates and Bases views. Paths are relative to the vault root.
 * `src/scaffold/vault/manifest.json` maps each vault path to its source file;
 * `scripts/export-ai-files.mjs` exports the same set for manual installation.
 */
export const VAULT_SCAFFOLD: readonly { path: readonly string[]; content: string }[] = Object.entries(manifest)
  .map(([target, source]) => {
    const content = sources[`../scaffold/vault/${source}`];
    if (content === undefined) throw new Error(`Vault scaffold source missing: ${source}`);
    return { path: target.split("/"), content };
  });
