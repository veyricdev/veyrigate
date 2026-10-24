// A7 (DEBT-269): the UI preference cookies written by JS (`theme`, `sidebar_state`) are always
// SameSite=Lax and Secure on https. Never HttpOnly by design (JS writes them, no secret, the
// server whitelists the value). Spy on the document.cookie setter: the raw string is what counts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { persistTheme } from "@/features/theme/theme";

let written: string[];
const startUrl = location.href;
// happy-dom API (not in the DOM lib types): switches the page URL, protocol included.
const setUrl = (url: string) => (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);

beforeEach(() => {
  written = [];
  vi.spyOn(document, "cookie", "set").mockImplementation((v: string) => void written.push(v));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setUrl(startUrl);
});

async function toggleSidebar() {
  render(
    <SidebarProvider defaultOpen>
      <SidebarTrigger />
    </SidebarProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
}

const attrs = (cookie: string) => cookie.split(";").map((p) => p.trim());

describe.each([
  ["http://localhost:3000/", false],
  ["https://admin.example/", true],
])("UI preference cookies on %s", (url, secure) => {
  beforeEach(() => setUrl(url));

  it("theme: SameSite=Lax, Path=/, Max-Age, Secure only on https, never HttpOnly", () => {
    persistTheme("dark");
    expect(written).toHaveLength(1);
    const a = attrs(written[0]);
    expect(a[0]).toBe("theme=dark");
    expect(a).toEqual(expect.arrayContaining(["Path=/", "SameSite=Lax", `Max-Age=${60 * 60 * 24 * 365}`]));
    expect(a.includes("Secure")).toBe(secure);
    expect(a.some((p) => /^httponly$/i.test(p))).toBe(false);
  });

  it("sidebar_state: same attributes through the same helper", async () => {
    await toggleSidebar();
    const cookie = written.find((c) => c.startsWith("sidebar_state="));
    expect(cookie).toBeDefined();
    const a = attrs(cookie!);
    expect(a[0]).toBe("sidebar_state=false");
    expect(a).toEqual(expect.arrayContaining(["Path=/", "SameSite=Lax", `Max-Age=${60 * 60 * 24 * 7}`]));
    expect(a.includes("Secure")).toBe(secure);
  });
});
