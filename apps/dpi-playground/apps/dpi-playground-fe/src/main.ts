import { createApp } from "vue";
import App from "./App.vue";
import { ui } from "./client/store";
import { barePairHome, readPairHandoff } from "./client/pair-handoff";
import "./style.css";
import "./network.css";
import "./jobs.css";
import "./extensions.css";
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
