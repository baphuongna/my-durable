/**
 * GET /pair — the DEVICE-side enrollment page (gap #4).
 *
 * A zero-dependency static page served by the device backend: it reads the
 * pairing offer from ITS OWN #offer= fragment (pasted link or the hub page's
 * handoff link), drives the local enroll API, and shows the live ceremony —
 * hub origin, device name, full key fingerprint, approval status. The offer
 * never leaves the machine: the fragment is not sent to any hub, and the
 * enroll API is a narrow, CSRF-guarded, unpaired-only surface.
 */
export const PAIR_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair this device — dpi</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.55 system-ui, sans-serif; background: #10141a; color: #e6ebf2;
         display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 24px; }
  .card { max-width: 560px; width: 100%; background: #171d26; border: 1px solid #2a3442;
          border-radius: 14px; padding: 28px 30px; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { color: #8fa0b5; margin: 0 0 20px; font-size: 13.5px; }
  dl { margin: 0 0 18px; display: grid; grid-template-columns: 130px 1fr; gap: 7px 12px; font-size: 13.5px; }
  dt { color: #8fa0b5; }
  dd { margin: 0; word-break: break-all; font-family: ui-monospace, monospace; }
  .fp { color: #7ee2a8; }
  .hub { color: #8ab4f8; }
  input { width: 100%; padding: 10px 12px; border-radius: 9px; border: 1px solid #2a3442;
          background: #10141a; color: #e6ebf2; font: inherit; margin-bottom: 12px; }
  button { width: 100%; padding: 11px 14px; border-radius: 9px; border: 0; cursor: pointer;
           font: 600 14.5px/1 system-ui; background: #3d7dffa0; }
  button:disabled { opacity: .45; cursor: default; }
  .status { margin-top: 16px; font-size: 13.5px; }
  .ok { color: #7ee2a8; } .warn { color: #f5c26b; } .err { color: #f28b82; }
  .spin { display: inline-block; animation: s 1s linear infinite; }
  @keyframes s { to { transform: rotate(360deg); } }
  .note { margin-top: 14px; color: #67788e; font-size: 12.5px; }
</style>
</head>
<body>
<div class="card">
  <h1>Pair this device</h1>
  <p class="sub">This machine will hold the credential and stay connected — the browser only starts it.</p>
  <dl id="meta" hidden>
    <dt>hub</dt><dd class="hub" id="hub"></dd>
    <dt>device</dt><dd id="device"></dd>
    <dt>key fingerprint</dt><dd class="fp" id="fp"></dd>
  </dl>
  <label for="offer" style="display:block;font-size:13px;color:#8fa0b5;margin-bottom:6px">Offer link (starts with the hub's https://…/pair#offer=…)</label>
  <input id="offer" placeholder="https://hub.example.com/pair#offer=…" spellcheck="false">
  <button id="go">Pair this device</button>
  <div class="status" id="status"></div>
  <p class="note">Compare the fingerprint with the hub wizard before approving there. Credential and keys live in this machine's dpi home, never in the browser.</p>
</div>
<script>
(function () {
  var offerEl = document.getElementById("offer");
  var go = document.getElementById("go");
  var statusEl = document.getElementById("status");
  var meta = document.getElementById("meta");
  var H = { "content-type": "application/json", "x-dpi-pair": "1" };
  function say(text, cls) { statusEl.innerHTML = text ? '<span class="' + (cls || "") + '">' + text + "</span>" : ""; }
  // The hub handoff link put the offer in THIS page's fragment.
  if (location.hash.indexOf("#offer=") === 0) offerEl.value = location.href;
  function poll() {
    fetch("/v1/pair-enroll", { headers: H })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        render(s);
        if (s.state === "pairing") { say('<span class="spin">&#9696;</span> waiting for approval on the hub…', "warn"); setTimeout(poll, 2000); }
        else if (s.state === "paired") say("paired — credential saved. You can close this page and open <b>dpi tui</b>.", "ok");
      })
      .catch(function () { setTimeout(poll, 3000); });
  }
  function render(s) {
    meta.hidden = false;
    document.getElementById("device").textContent = s.deviceName || "";
    if (s.fingerprint) document.getElementById("fp").textContent = s.fingerprint;
    if (s.hubOrigin || (s.pending && s.pending.hubOrigin)) document.getElementById("hub").textContent = s.hubOrigin || s.pending.hubOrigin;
  }
  function load() {
    fetch("/v1/pair-enroll", { headers: H })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        render(s);
        if (s.state === "pairing") poll();
        if (s.lastError) say(s.lastError, "err");
      }).catch(function () {});
  }
  go.addEventListener("click", function () {
    var pairUrl = offerEl.value.trim();
    if (!pairUrl) { say("paste the offer link first", "err"); return; }
    go.disabled = true;
    say("starting…", "");
    fetch("/v1/pair-enroll", { method: "POST", headers: H, body: JSON.stringify({ pairUrl: pairUrl }) })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (o) {
        if (!o.ok) { say((o.b && o.b.error && o.b.error.message) || "refused", "err"); go.disabled = false; return; }
        poll();
      })
      .catch(function () { say("cannot reach the local backend — is <b>dpi device</b> running?", "err"); go.disabled = false; });
  });
  load();
})();
</script>
</body>
</html>
`;
