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
// VISUAL viewport and feed it to the shell heights as --vvh. Android follows
// interactive-widget=resizes-content instead, where this var simply agrees
// with the resized dvh. Plain pixels — the ui rides rem now, no zoom math.
{
  const vv = window.visualViewport;
  const root = document.documentElement;
  const apply = () => {
    const vh = Math.max(vv?.height ?? window.innerHeight, window.innerHeight);
    root.style.setProperty("--vvh", `${Math.round(vh)}px`);
  };
  vv?.addEventListener("resize", apply);
  vv?.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);
  apply();
}

// ?debug=1 — an evidence panel for live engine diagnosis (one screenshot
// answers: which engine, which viewport, which visual scale, which knob).
{
  if (/[?&]debug=1\b/.test(location.search)) {
    setTimeout(() => {
      const el = document.createElement("pre");
      el.style.cssText = "position:fixed;left:6px;bottom:6px;z-index:99999;background:#000d;color:#fff;padding:8px;font:11px/1.5 ui-monospace,monospace;max-width:92vw;border-radius:6px;white-space:pre-wrap";
      const vv = window.visualViewport;
      const upd = () => {
        el.textContent = [
          `UA: ${navigator.userAgent}`,
          `innerW×H: ${innerWidth}×${innerHeight}`,
          `clientW: ${document.documentElement.clientWidth}`,
          `visualViewport: ${vv ? `${Math.round(vv.width)}×${Math.round(vv.height)} scale=${vv.scale.toFixed(3)}` : "none"}`,
          `root font-size: ${getComputedStyle(document.documentElement).fontSize}`,
          `dpr: ${devicePixelRatio}`,
          `mq740: ${matchMedia("(max-width: 740px)").matches}`,
          `touch: ${matchMedia("(pointer: coarse)").matches}`,
        ].join("\n");
      };
      vv?.addEventListener("resize", upd);
      vv?.addEventListener("scroll", upd);
      window.addEventListener("resize", upd);
      upd();
      document.body.appendChild(el);
    }, 600);
  }
}
