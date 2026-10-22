// @vitest-environment happy-dom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { apiSakaiStatus } from "../src/lib/sakai";

afterEach(clearMocks);

describe("apiSakaiStatus", () => {
  it("only exposes non-secret session status fields", async () => {
    mockIPC(() => ({ connected: true, loginOpen: false, rememberSession: true, persistenceError: false, privateExtra: "synthetic" }));

    expect(await apiSakaiStatus()).toEqual({ connected: true, loginOpen: false, rememberSession: true, persistenceError: false });
  });

  it.each([null, [], {}, { connected: true }, { connected: true, loginOpen: false, rememberSession: "true", persistenceError: false }])(
    "rejects malformed status %s", async (response) => {
      mockIPC(() => response);
      await expect(apiSakaiStatus()).rejects.toThrow("Ungültiger Sakai-Anmeldestatus");
    },
  );

  it("only sends explicit consent to the native persistence boundary", async () => {
    let call: unknown;
    mockIPC((command, payload) => {
      call = { command, payload };
      return { connected: false, loginOpen: false, rememberSession: true, persistenceError: false };
    });
    await apiSakaiStatus("sakai_set_remember_session", true);

    expect(call).toEqual({ command: "sakai_set_remember_session", payload: { remember: true } });
  });
});
