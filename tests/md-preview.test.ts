// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MdPreview, renderMarkdown } from "../src/components/MdPreview";

const restoreDOM = vi.hoisted(() => {
  const nodeName = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName")!;
  const createNodeIterator = document.createNodeIterator;
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(document, "createNodeIterator");

  // DOMPurify caches this getter; happy-dom only implements it on subclasses.
  Object.defineProperty(Node.prototype, "nodeName", {
    ...nodeName,
    get(this: Node): string {
      let prototype = Object.getPrototypeOf(this);
      while (prototype && prototype !== Node.prototype) {
        const getter = Object.getOwnPropertyDescriptor(prototype, "nodeName")?.get;
        if (getter) return getter.call(this);
        prototype = Object.getPrototypeOf(prototype);
      }
      return nodeName.get!.call(this);
    },
  });

  // happy-dom stops walking after node removal; snapshot the sanitizer's input.
  document.createNodeIterator = function (...args) {
    const iterator = createNodeIterator.apply(this, args);
    const nodes: Node[] = [];
    let node: Node | null;
    while ((node = iterator.nextNode())) nodes.push(node);
    let index = 0;
    iterator.nextNode = () => nodes[index++] ?? null;
    return iterator;
  };

  return () => {
    Object.defineProperty(Node.prototype, "nodeName", nodeName);
    if (iteratorDescriptor) Object.defineProperty(document, "createNodeIterator", iteratorDescriptor);
    else Reflect.deleteProperty(document, "createNodeIterator");
  };
});

afterAll(restoreDOM);

let root: Root;
let container: HTMLDivElement;
const onOpenFile = vi.fn();
const onOpenLink = vi.fn();
const onOpenWiki = vi.fn();
const executeScript = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("alert", executeScript);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("renderMarkdown", () => {
  it("keeps docs pills and plain note references by default", () => {
    const source = "[[docs/One.pdf]] ![[docs/Two.pdf|Slides]] [[Termin]] [[Termin#Heading|Alias]] ![[Image.png]]";
    const expected = '<p><a class="wl-pill" data-open="docs/One.pdf" href="#">docs/One.pdf</a> '
      + '<a class="wl-pill" data-open="docs/Two.pdf" href="#">Slides</a> '
      + '<span class="wl-text">Termin</span> <span class="wl-text">Alias</span> '
      + '<span class="wl-text">Image.png</span></p>\n';

    expect(renderMarkdown(source)).toBe(expected);
    expect(renderMarkdown(source, false)).toBe(expected);
  });

  it("renders both docs and note references as wiki pills when enabled", () => {
    const html = renderMarkdown("[[docs/One.pdf|File]] ![[Termin#Heading|Note]]", true);

    expect(html).toBe('<p><a class="wl-pill" data-wiki="docs/One.pdf" href="#">File</a> '
      + '<a class="wl-pill" data-wiki="Termin#Heading" href="#">Note</a></p>\n');
  });
});

describe("MdPreview", () => {
  it.each([
    ["[[Termin]]", "Termin", "Termin"],
    ["[[ Überblick/Änderungen 東京#Nächste Schritte | Öffnen ]]", "Überblick/Änderungen 東京#Nächste Schritte", "Öffnen"],
    ["[[#Heading]]", "#Heading", "#Heading"],
    ["[[../Andere Notiz.md#Heading|Relative]]", "../Andere Notiz.md#Heading", "Relative"],
    ["[[Note%20Name#Heading|Encoded]]", "Note%20Name#Heading", "Encoded"],
    ["[[docs/One.pdf|File]]", "docs/One.pdf", "File"],
    ["![[docs/Two.pdf]]", "docs/Two.pdf", "docs/Two.pdf"],
    ["![[Image.png|Image]]", "Image.png", "Image"],
    ['[[A&B "quoted" <note>|A&B "quoted" <label>]]', 'A&B "quoted" <note>', 'A&B "quoted" <label>'],
    ["[[javascript:alert(1)|Unresolved]]", "javascript:alert(1)", "Unresolved"],
  ])("opens %s through a focusable wiki link without resolving its target", async (text, target, label) => {
    await act(async () => root.render(createElement(MdPreview, { text, onOpenFile, onOpenLink, onOpenWiki })));
    const link = container.querySelector<HTMLAnchorElement>("a.wl-pill")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    expect(link.textContent).toBe(label);
    expect(link.getAttribute("data-wiki")).toBe(target);
    expect(link.getAttribute("href")).toBe("#");
    expect(link.hasAttribute("data-open")).toBe(false);
    expect(link.tabIndex).toBe(0);
    link.focus();
    expect(document.activeElement).toBe(link);
    await act(async () => link.dispatchEvent(click));

    expect(click.defaultPrevented).toBe(true);
    expect(onOpenWiki.mock.calls).toEqual([[target]]);
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(onOpenLink).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("keeps appointment note references inert and docs embeds delegated to files", async () => {
    const text = "[[Termin|Note]] ![[docs/Übung 1.pdf|File]]";
    await act(async () => root.render(createElement(MdPreview, { text, onOpenFile, onOpenLink })));

    await act(async () => container.querySelector<HTMLSpanElement>(".wl-text")!.click());
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(container.querySelector("[data-wiki]")).toBeNull();
    await act(async () => container.querySelector<HTMLAnchorElement>("a[data-open]")!.click());

    expect(onOpenFile.mock.calls).toEqual([["docs/Übung 1.pdf"]]);
    expect(onOpenLink).not.toHaveBeenCalled();
    expect(onOpenWiki).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves escaped aliases and columns in Markdown tables (wiki mode: %s)", async (wikiLinks) => {
    const text = String.raw`| Reference | Value |
| --- | --- |
| [[Überblick/Notiz#Übung\|Öffnen \| Details]] | first |
| ![[docs/Übung 1.pdf\|Anhang]] | second |`;
    await act(async () => root.render(createElement(MdPreview, {
      text, onOpenFile, onOpenLink, onOpenWiki: wikiLinks ? onOpenWiki : undefined,
    })));
    const cells = [...container.querySelectorAll("tbody td")];
    const note = cells[0].firstElementChild!;
    const file = cells[2].querySelector<HTMLAnchorElement>("a")!;

    expect(cells.map((cell) => cell.textContent)).toEqual(["Öffnen | Details", "first", "Anhang", "second"]);
    expect(note.tagName).toBe(wikiLinks ? "A" : "SPAN");
    expect(note.getAttribute("data-wiki")).toBe(wikiLinks ? "Überblick/Notiz#Übung" : null);
    expect(file.getAttribute(wikiLinks ? "data-wiki" : "data-open")).toBe("docs/Übung 1.pdf");
    await act(async () => file.click());
    expect(onOpenWiki.mock.calls).toEqual(wikiLinks ? [["docs/Übung 1.pdf"]] : []);
    expect(onOpenFile.mock.calls).toEqual(wikiLinks ? [] : [["docs/Übung 1.pdf"]]);
  });

  it("updates wiki mode and uses the current callback when props change", async () => {
    const props = { text: "[[Termin]]", onOpenFile, onOpenLink };
    const nextOpenWiki = vi.fn();
    await act(async () => root.render(createElement(MdPreview, props)));
    expect(container.querySelector("a")).toBeNull();

    await act(async () => root.render(createElement(MdPreview, { ...props, onOpenWiki })));
    await act(async () => container.querySelector<HTMLAnchorElement>("a")!.click());
    await act(async () => root.render(createElement(MdPreview, { ...props, onOpenWiki: nextOpenWiki })));
    await act(async () => container.querySelector<HTMLAnchorElement>("a")!.click());
    expect(onOpenWiki.mock.calls).toEqual([["Termin"]]);
    expect(nextOpenWiki.mock.calls).toEqual([["Termin"]]);

    await act(async () => root.render(createElement(MdPreview, props)));
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector(".wl-text")?.textContent).toBe("Termin");
  });

  it.each([false, true])("preserves external and docs Markdown link delegation (wiki mode: %s)", async (wikiLinks) => {
    const text = "[**External**](https://example.test/page?q=1&lang=de) "
      + "[File](docs/%C3%9Cbung%201.pdf) [Malformed](docs/bad%ZZ.pdf) [Heading](#Heading)";
    await act(async () => root.render(createElement(MdPreview, {
      text, onOpenFile, onOpenLink, onOpenWiki: wikiLinks ? onOpenWiki : undefined,
    })));
    const links = container.querySelectorAll<HTMLAnchorElement>("a");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    await act(async () => links[0].querySelector("strong")!.dispatchEvent(click));
    await act(async () => links[1].click());
    await act(async () => links[2].click());
    await act(async () => links[3].click());

    expect(click.defaultPrevented).toBe(true);
    expect(onOpenLink.mock.calls).toEqual([["https://example.test/page?q=1&lang=de"]]);
    expect(onOpenFile.mock.calls).toEqual([["docs/Übung 1.pdf"], ["docs/bad%ZZ.pdf"]]);
    expect(onOpenWiki).not.toHaveBeenCalled();
  });

  it.each([
    ["[[Termin|Note]]", true, "a"],
    ["[[docs/One.pdf]]", false, "a"],
    ["[**External**](https://example.test)", true, "strong"],
  ])("blocks middle clicks on %s without delegating", async (text, wikiLinks, selector) => {
    await act(async () => root.render(createElement(MdPreview, {
      text, onOpenFile, onOpenLink, onOpenWiki: wikiLinks ? onOpenWiki : undefined,
    })));
    const click = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });

    await act(async () => container.querySelector(selector)!.dispatchEvent(click));

    expect(click.defaultPrevented).toBe(true);
    expect(onOpenWiki).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it.each([false, true])("sanitizes raw HTML and scripts while preserving safe markup (wiki mode: %s)", async (wikiLinks) => {
    const text = '<strong>Safe</strong><script>alert("script")</script>'
      + '<img src="missing-image" onerror="alert(1)"><svg onload="alert(2)"></svg>'
      + '<a href="https://example.test" onclick="alert(3)">External</a>';
    await act(async () => root.render(createElement(MdPreview, {
      text, onOpenFile, onOpenLink, onOpenWiki: wikiLinks ? onOpenWiki : undefined,
    })));

    expect(container.querySelector("strong")?.textContent).toBe("Safe");
    expect(container.querySelector("script, [onerror], [onload], [onclick]")).toBeNull();
    await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
    await act(async () => container.querySelector("svg")!.dispatchEvent(new Event("load")));
    await act(async () => container.querySelector<HTMLAnchorElement>("a")!.click());

    expect(executeScript).not.toHaveBeenCalled();
    expect(onOpenLink.mock.calls).toEqual([["https://example.test"]]);
  });

  it.each([
    '[Unsafe](javascript:alert%281%29)',
    '<a href="javascript:alert(1)">Unsafe</a>',
    '<a href="java&#x73;cript:alert(1)">Unsafe</a>',
    '<a href="java&#x09;script:alert(1)">Unsafe</a>',
    '<a href="data:text/html,<script>alert(1)</script>">Unsafe</a>',
    '<a href="vbscript:msgbox(1)">Unsafe</a>',
  ])("removes dangerous hrefs without executing or delegating: %s", async (text) => {
    await act(async () => root.render(createElement(MdPreview, { text, onOpenFile, onOpenLink, onOpenWiki })));
    const link = container.querySelector<HTMLAnchorElement>("a")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    expect(link.hasAttribute("href")).toBe(false);
    await act(async () => link.dispatchEvent(click));

    expect(click.defaultPrevented).toBe(true);
    expect(executeScript).not.toHaveBeenCalled();
    expect(onOpenWiki).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("escapes wiki targets and aliases that attempt HTML attribute or script injection", async () => {
    const target = 'Note" onclick="alert(1)';
    const label = '<img src=x onerror="alert(2)"><script>alert(3)</script>';
    await act(async () => root.render(createElement(MdPreview, {
      text: `[[${target}|${label}]]`, onOpenFile, onOpenLink, onOpenWiki,
    })));
    const link = container.querySelector<HTMLAnchorElement>("a")!;

    expect(link.getAttribute("data-wiki")).toBe(target);
    expect(link.textContent).toBe(label);
    expect(container.querySelector("img, script, [onclick], [onerror]")).toBeNull();
    await act(async () => link.click());

    expect(onOpenWiki.mock.calls).toEqual([[target]]);
    expect(onOpenLink).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });
});
