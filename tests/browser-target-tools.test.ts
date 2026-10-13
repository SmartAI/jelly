import { expect, test } from "bun:test";
import { interventionTools } from "../src/server/agent-tools";
import type { TObject } from "typebox";
import type { Interventions } from "../src/server/interventions";

function tools(target: "managed" | "chrome") {
  return interventionTools({ target, get: () => { throw new Error("Must not allocate a browser while registering tools"); } }, {} as Interventions, "agent", "run", "/tmp");
}

test("Chrome advertises only supported tools and reference-only inputs", () => {
  const list = tools("chrome");
  const names = list.map(tool => tool.name);
  expect(names).toContain("browser_keep_tab");
  expect(names).toContain("browser_select");
  for (const name of ["browser_type", "browser_upload", "browser_diagnostics"]) expect(names).not.toContain(name);
  const click = list.find(tool => tool.name === "browser_click")!;
  expect(Object.keys((click.parameters as TObject).properties)).toEqual(["ref"]);
  const key = list.find(tool => tool.name === "browser_key")!;
  expect((key.parameters as TObject).required).toContain("ref");
  expect(key.description).not.toContain("Managed browser:");
  const login = list.find(tool => tool.name === "request_browser_login")!;
  expect(login.description).toContain("Settings → Browser target");
});

test("managed sessions retain managed tools without Chrome-only tools", () => {
  const list = tools("managed");
  const names = list.map(tool => tool.name);
  expect(names).toContain("browser_type");
  expect(names).toContain("browser_upload");
  expect(names).toContain("browser_diagnostics");
  for (const name of ["browser_keep_tab", "browser_name_task", "browser_select"]) expect(names).not.toContain(name);
  expect(list.find(tool => tool.name === "browser_key")!.description).not.toContain("Connected Chrome");
});
