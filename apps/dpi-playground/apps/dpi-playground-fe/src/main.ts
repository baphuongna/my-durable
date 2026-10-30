import { createApp } from "vue";
import App from "./App.vue";
import { ui } from "./client/store";
import { installAdminLoginFetch } from "./client/auth";
import { barePairHome, readPairHandoff } from "./client/pair-handoff";
import "./style.css";
import "./network.css";
import "./jobs.css";
import "./extensions.css";
// Before anything can call out: a 401 from an admin route raises the login card
// and the failed call is retried after a successful login (client/auth.ts).
installAdminLoginFetch();
const url = new URL(window.location.href);
if (/^\/pair\/?$/.test(url.pathname)) {
  const handoff = readPairHandoff(url);
  if (handoff) {
    url.search = "";
    url.hash = "";
    window.history.replaceState(window.history.state, "", url);
    ui.dialog = { kind: "pair", handoff };
  } else {
    // bare /pair: no handoff to resume — do not re-open the wizard or mint a fresh code
    window.history.replaceState(window.history.state, "", barePairHome(url));
  }
}
createApp(App).mount("#app");

// Soft keyboard, iOS: the layout viewport never resizes, so measure the
// VISUAL viewport and feed it to the shell heights as --vvh (in root zoom
// coordinates: rendered = var × zoom = the real visible height). Android
// follows interactive-widget=resizes-content instead, where this var simply
// agrees with the resized dvh.
{
  const vv = window.visualViewport;
  const root = document.documentElement;
  const apply = () => {
    const z = parseFloat(getComputedStyle(root).zoom || "1") || 1;
    root.style.setProperty("--vvh", `${(vv?.height ?? window.innerHeight) / z}px`);
  };
  vv?.addEventListener("resize", apply);
  vv?.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);
  apply();
}
