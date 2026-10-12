import { expect, test } from "bun:test";
import { ControlSessions } from "../src/server/control-session";

const http = (cookie?: string, csrf?: string) =>
  new Request("http://127.0.0.1:5173/api/state", {
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-jelly-csrf": csrf } : {}),
    },
  });
const https = (cookie?: string, csrf?: string) =>
  new Request("https://jelly.tailfixture.ts.net/api/state", {
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-jelly-csrf": csrf } : {}),
    },
  });
test("control-session parser rejects duplicate current/legacy cookies independently of API guards", () => {
  const controls = new ControlSessions();
  const issued = controls.create(http());
  const cookie = issued.cookie.split(";")[0]!;
  expect(controls.require(http(cookie, issued.session.csrf))).toBe(
    issued.session,
  );
  for (const ambiguous of [
    cookie + "; " + cookie,
    "jelly_control=forged; " + cookie,
    cookie + "; __Host-jelly_control=forged",
    "jelly_control; " + cookie,
  ]) {
    expect(() => controls.get(http(ambiguous))).toThrow("Ambiguous");
    expect(() => controls.create(http(ambiguous))).toThrow("Ambiguous");
    expect(() => controls.require(http(ambiguous))).toThrow("Ambiguous");
  }
  expect(() => controls.require(http(cookie, "incorrect"))).toThrow(
    "control token",
  );
  expect(controls.create(http(cookie)).session.csrf).toBe(issued.session.csrf);
});
test("HTTPS uses Secure host-only __Host cookies and retires, rather than adopts, HTTP legacy credentials", () => {
  const controls = new ControlSessions();
  const legacy = controls.create(http());
  const secure = controls.create(https(legacy.cookie.split(";")[0]));
  expect(secure.cookie).toStartWith("__Host-jelly_control=");
  expect(secure.cookie).toContain("Secure; HttpOnly; SameSite=Strict; Path=/;");
  expect(secure.cookie).not.toContain("Domain");
  expect(secure.session.id).not.toBe(legacy.session.id);
  expect(secure.retiredCookies).toHaveLength(2);
  expect(secure.retiredCookies.join()).toContain("Path=/api; Max-Age=0");
  const cookie = secure.cookie.split(";")[0]!;
  expect(controls.require(https(cookie, secure.session.csrf))).toBe(
    secure.session,
  );
  expect(controls.get(http(cookie))).toBeNull();
  expect(controls.get(https(legacy.cookie.split(";")[0]))).toBeNull();
  expect(controls.create(https(cookie)).session.csrf).toBe(secure.session.csrf);
});
test("trusted HTTPS proxy hosts require secure cookies without trusting arbitrary forwarded headers or app ports", () => {
  const controls = new ControlSessions(["https://jelly.tailfixture.ts.net"]);
  const req = (host: string) =>
    new Request("http://127.0.0.1:5173/api/control-session", {
      headers: { host, "x-forwarded-proto": "https" },
    });
  expect(controls.create(req("jelly.tailfixture.ts.net")).cookie).toStartWith(
    "__Host-jelly_control=",
  );
  expect(
    controls.create(req("jelly.tailfixture.ts.net:40000")).cookie,
  ).toStartWith("jelly_control=");
  expect(controls.create(req("127.0.0.1:5173")).cookie).toStartWith(
    "jelly_control=",
  );
});
