// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/lib/types";

vi.mock("../src/lib/storage", () => ({ apiChooseVaultRoot: vi.fn(async () => "/Users/example/MCI") }));

const { SetupWizard } = await import("../src/components/SetupWizard");

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

describe("SetupWizard", () => {
  it("requires folder and calendar link before saving the validated config", async () => {
    const onSave = vi.fn(async () => {});
    const onClose = vi.fn();
    await act(async () => root.render(createElement(SetupWizard, { cfg: { ...DEFAULT_CONFIG, basisPfad: "" }, disabled: false, onSave, onClose })));

    await submit();
    expect(container.textContent).toContain("Schritt 2 von 5");
    await submit();
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Bitte einen Studienordner auswählen.");

    await act(async () => button("Ordner auswählen …").click());
    await submit();
    expect(container.textContent).toContain("Schritt 3 von 5");
    await submit();
    expect(container.querySelector("[role=alert]")?.textContent).toBe("Bitte eine gültige Kalender-URL eingeben.");

    await type(container.querySelector("input[type=password]") as HTMLInputElement, "webcal://example.invalid/cal.ics");
    await submit();
    await submit();
    expect(container.textContent).toContain("Schritt 5 von 5");
    expect(onSave).not.toHaveBeenCalled();

    await submit();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      basisPfad: "/Users/example/MCI",
      icalUrl: "https://example.invalid/cal.ics",
      semester: DEFAULT_CONFIG.semester,
    }));
    expect(onClose).toHaveBeenCalled();
  });
});
