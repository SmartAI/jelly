import { installJellyBridge } from "./jelly-bridge.mjs";

const status = document.querySelector("#status");
try {
  const configResponse = await fetch("/jelly-config.json", {
    credentials: "omit",
    redirect: "error",
  });
  if (!configResponse.ok) throw new Error("Unavailable");
  const config = await configResponse.json();
  document.body.dataset.corner = config.corner;
  const bridge = installJellyBridge({
    ...config,
    homeLink: document.querySelector("#jelly-home"),
  });
  // Establish direct home navigation before loading app data, so data failures keep it usable.
  const noteResponse = await fetch("/note.json", {
    credentials: "omit",
    redirect: "error",
  });
  if (!noteResponse.ok) throw new Error("Unavailable");
  const note = await noteResponse.json();
  document.querySelector("#title").textContent = note.title;
  document.querySelector("#note").textContent = note.body;
  status.textContent = "";
  // Report only safe relative paths, never query strings, hashes, OAuth tokens or arbitrary URLs.
  bridge.reportRoute(location.pathname);
  addEventListener("popstate", () => bridge.reportRoute(location.pathname));
} catch {
  status.textContent =
    "App unavailable. Open Jelly Apps to inspect status or try again.";
}
