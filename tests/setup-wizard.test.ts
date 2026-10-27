// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/lib/types";

const storage = vi.hoisted(() => ({
  apiChooseVaultRoot: vi.fn(async () => "/Users/example/MCI"),
  apiObsidianInstalled: vi.fn(async () => true),
  apiOpenExternalUrl: vi.fn(async () => {}),
  apiOpenObsidian: vi.fn(async () => {}),
  apiRevealVaultPath: vi.fn(async () => {}),
}));
vi.mock("../src/lib/storage", () => storage);

const { SetupWizard } = await import("../src/components/SetupWizard");

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  storage.apiObsidianInstalled.mockResolvedValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label) as HTMLButtonElement;

const submit = async () => {
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
};

const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const render = async (props: { onSave?: () => Promise<string | null>; onClose?: () => void; basisPfad?: string } = {}) => {
  const onSave = vi.fn(props.onSave ?? (async () => null));
  const onClose = vi.fn(props.onClose ?? (() => {}));
  await act(async () => root.render(createElement(SetupWizard, {
    cfg: { ...DEFAULT_CONFIG, basisPfad: props.basisPfad ?? "" }, disabled: false, onSave, onClose,
  })));
  return { onSave, onClose };
};

describe("SetupWizard", () => {
  it("requires folder and calendar link before saving the validated config", async () => {
    const { onSave, onClose } = await render();

    await submit();
    await submit();
    expect(container.textContent).toContain("Schritt 3 von 6");
    await submit();
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Bitte einen Studienordner auswählen.");

    await act(async () => button("Ordner auswählen …").click());
    await submit();
    expect(container.textContent).toContain("Schritt 4 von 6");
    await submit();
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Bitte eine gültige Kalender-URL eingeben.");

    await type(container.querySelector("input[type=password]") as HTMLInputElement, "webcal://example.invalid/cal.ics");
    await submit();
    await submit();
    expect(container.textContent).toContain("Schritt 6 von 6");
    expect(onSave).not.toHaveBeenCalled();

    await submit();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      basisPfad: "/Users/example/MCI",
      icalUrl: "https://example.invalid/cal.ics",
      semester: DEFAULT_CONFIG.semester,
    }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows how to connect the new vault in Obsidian after setup and closes on request", async () => {
    const { onClose } = await render({ basisPfad: "/Users/example/MCI" });
    await submit();
    await submit();
    await submit();
    await type(container.querySelector("input[type=password]") as HTMLInputElement, "https://example.invalid/cal.ics");
    await submit();
    await submit();
    await submit();

    expect(container.textContent).toContain("Dein Studienordner ist bereit");
    await act(async () => button("Obsidian öffnen").click());
    await act(async () => button("Im Finder zeigen").click());
    await act(async () => button("Los geht’s").click());

    expect([storage.apiOpenObsidian.mock.calls.length, storage.apiRevealVaultPath.mock.calls[0], onClose.mock.calls.length])
      .toEqual([1, ["/Users/example/MCI"], 1]);
  });

  it("offers the official Obsidian download when it is not installed", async () => {
    storage.apiObsidianInstalled.mockResolvedValue(false);
    await render();
    await submit();

    expect(container.textContent).toContain("Obsidian ist noch nicht installiert.");
    await act(async () => button("Obsidian herunterladen").click());

    expect(storage.apiOpenExternalUrl).toHaveBeenCalledWith("https://obsidian.md/download");
  });

  it("detects a fresh Obsidian installation when checking again", async () => {
    storage.apiObsidianInstalled.mockResolvedValue(false);
    await render();
    await submit();
    storage.apiObsidianInstalled.mockResolvedValue(true);

    await act(async () => button("Erneut prüfen").click());

    expect(container.textContent).toContain("✓ Obsidian ist installiert.");
  });

  it("stays on the last step and shows the sync error when the first sync fails", async () => {
    await render({ basisPfad: "/Users/example/MCI", onSave: async () => "Stundenplan konnte nicht geladen werden: HTTP 404" });
    await submit();
    await submit();
    await submit();
    await type(container.querySelector("input[type=password]") as HTMLInputElement, "https://example.invalid/cal.ics");
    await submit();
    await submit();
    await submit();

    expect([container.querySelector("[role=alert]")?.textContent, container.textContent?.includes("Dein Studienordner ist bereit")])
      .toEqual(["Einstellungen gespeichert, aber die Einrichtung ist nicht fertig. Stundenplan konnte nicht geladen werden: HTTP 404", false]);
  });

  it("keeps the wizard on the last step when setup fails", async () => {
    await render({ basisPfad: "/Users/example/MCI", onSave: async () => { throw new Error("Kalender nicht erreichbar."); } });
    await submit();
    await submit();
    await submit();
    await type(container.querySelector("input[type=password]") as HTMLInputElement, "https://example.invalid/cal.ics");
    await submit();
    await submit();
    await submit();

    expect([container.querySelector("[role=alert]")?.textContent, container.textContent?.includes("Schritt 6 von 6")])
      .toEqual(["Kalender nicht erreichbar.", true]);
  });
});
