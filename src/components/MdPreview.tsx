import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.use({ breaks: true, gfm: true });

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\|/g, "&#124;");
}

/** Convert wikilinks to pills before parsing Markdown.
 *  By default only docs/ links open files; other references remain text.
 *  With wikiLinks enabled, all targets are delegated to the parent resolver. */
export function renderMarkdown(src: string, wikiLinks = false): string {
  const link = (targetRaw: string, labelRaw: string | undefined): string => {
    const target = targetRaw.trim();
    const label = esc((labelRaw?.replace(/\\\|/g, "|") ?? target).trim());
    const t = esc(target);
    if (wikiLinks) {
      return `<a class="wl-pill" data-wiki="${t}" href="#">${label}</a>`;
    }
    if (target.startsWith("docs/")) {
      return `<a class="wl-pill" data-open="${t}" href="#">${label}</a>`;
    }
    return `<span class="wl-text">${label}</span>`;
  };
  let s = src.replace(/!\[\[([^\]|]+?)(?:\\?\|([^\]]+))?\]\]/g, (_m, p1: string, p2: string) =>
    link(p1, p2),
  );
  s = s.replace(/\[\[([^\]|]+?)(?:\\?\|([^\]]+))?\]\]/g, (_m, p1: string, p2: string) => link(p1, p2));
  return marked.parse(s) as string;
}

export function MdPreview({
  text,
  onOpenFile,
  onOpenLink,
  onOpenWiki,
}: {
  text: string;
  onOpenFile: (rel: string) => void;
  onOpenLink: (url: string) => void;
  onOpenWiki?: (target: string) => void;
}) {
  const html = useMemo(
    () => DOMPurify.sanitize(renderMarkdown(text, !!onOpenWiki), { ADD_ATTR: ["data-open", "data-wiki"] }),
    [text, onOpenWiki],
  );
  return (
    <div
      className="md-preview"
      onAuxClick={(e) => {
        if ((e.target as Element).closest("a")) e.preventDefault();
      }}
      onClick={(e) => {
        const el = (e.target as Element).closest("a");
        if (!el) return;
        e.preventDefault();
        const wiki = el.getAttribute("data-wiki");
        if (wiki && onOpenWiki) { onOpenWiki(wiki); return; }
        const rel = el.getAttribute("data-open");
        if (rel) { onOpenFile(rel); return; }
        const href = el.getAttribute("href") ?? "";
        if (href.startsWith("docs/")) {
          try { onOpenFile(decodeURIComponent(href)); }
          catch { onOpenFile(href); }
        } else if (href && !href.startsWith("#")) {
          onOpenLink(href);
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
