<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Link2, ListChecks, Network, PanelLeftClose, PanelLeftOpen, Search, X } from "lucide-vue-next";
import DeviceIcon from "./DeviceIcon.vue";
import type { TreeNode } from "@sdk/models";
import TreeRow from "./TreeRow.vue";
import ProjectBar from "./ProjectBar.vue";
import { deviceClient, hub } from "../client/hub";
import { createWorktreeSession } from "../client/worktree";
import {
  attempt,
  expanded,
  layout,
  network,
  notify,
  select,
  selected,
  toggle,
  ui,
  panelKeys,
} from "../client/store";

interface Row {
  node: TreeNode;
  depth: number;
  parent?: string;
}

const rows = computed(() => {
  const out: Row[] = [];
  const walk = (nodes: TreeNode[], depth: number, parent?: string) => {
    for (const node of nodes) {
      out.push({ node, depth, parent });
      if (node.children.length && expanded.value.has(node.key))
        walk(node.children, depth + 1, node.key);
    }
  };
  walk(network.tree.value, 0);
  return out;
});
const focusKey = ref<string>();
const list = ref<HTMLElement>();

/** Session search (paseo `agent-history-search`, cheap v1). The local pass
 *  filters the tree instantly; the device pass asks each online device for its
 *  own matches (names/cwds/models) so results do not depend on how fresh the
 *  hub's tree is. Transcripts are not scanned — that needs an FTS index. */
const query = ref("");
const deviceHits = ref<
  {
    deviceId: string;
    name: string;
    cwd: string;
    id: string;
    where: string[];
    hits: { agent: string; entry: number; kind: string; text: string }[];
  }[]
>([]);
const searching = ref(false);
const needle = computed(() => query.value.trim().toLowerCase());
const filtering = computed(() => needle.value.length >= 2);

/** Sessions whose name/cwd matches — the anchor a filter keeps the tree around. */
const matchedSessions = computed(() => {
  const ids = new Set<string>();
  if (!filtering.value) return ids;
  for (const device of network.devices.value)
    for (const session of device.tree?.sessions ?? [])
      if (`${session.name}\n${session.cwd}`.toLowerCase().includes(needle.value)) ids.add(session.id);
  return ids;
});
/** A filter keeps the matched sessions, their agents, and the devices holding
 *  them — a hit you cannot locate in the tree is a riddle, not a result. */
/** Project chip filter: a session belongs to the project whose root holds its cwd. */
const projectFilter = ref<{ deviceId: string; rootPath: string }>();
const inProject = (deviceId: string, cwd: string) =>
  !projectFilter.value ||
  (projectFilter.value.deviceId === deviceId &&
    (cwd === projectFilter.value.rootPath || cwd.startsWith(`${projectFilter.value.rootPath}/`)));

const localRows = computed(() => {
  if (!filtering.value && !projectFilter.value) return rows.value;
  const keep = (node: TreeNode): boolean => {
    if (projectFilter.value) {
      const deviceId = node.type === "device" ? node.device.id : node.deviceId;
      if (node.type === "session" && !inProject(deviceId, node.session.cwd)) return false;
      if (node.type === "agent") {
        const session = network.devices.value
          .find((d) => d.id === node.deviceId)
          ?.tree?.sessions.find((s) => s.id === node.sessionId);
        if (session && !inProject(node.deviceId, session.cwd)) return false;
      }
      if (node.type === "device")
        return (node.device.tree?.sessions ?? []).some((s) => inProject(node.device.id, s.cwd));
    }
    if (!filtering.value) return true;
    if (node.type === "session") return matchedSessions.value.has(node.session.id);
    if (node.type === "agent")
      return matchedSessions.value.has(node.sessionId) || node.agent.name.toLowerCase().includes(needle.value);
    return (node.device.tree?.sessions ?? []).some((s) => matchedSessions.value.has(s.id));
  };
  const visible = new Set(rows.value.filter((row) => keep(row.node)).map((row) => row.node.key));
  return rows.value.filter((row) => visible.has(row.node.key));
});
/** Device hits the tree already shows are dropped: one row per session. */
const extraHits = computed(() =>
  deviceHits.value.filter((hit) => !rows.value.some((r) => r.node.type === "session" && r.node.session.id === hit.id)),
);

let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchGeneration = 0;
watch(query, (value) => {
  clearTimeout(searchTimer);
  const q = value.trim();
  if (q.length < 2) {
    ++searchGeneration; // an in-flight scan for the cleared query must not resurrect stale hits
    deviceHits.value = [];
    searching.value = false;
    return;
  }
  searchTimer = setTimeout(async () => {
    searching.value = true;
    // R18 cold-review minor 4: scope=all scans take seconds per device — a
    // generation token keeps a slower OLD query from overwriting a newer one.
    const generation = ++searchGeneration;
    const found: typeof deviceHits.value = [];
    for (const device of network.devices.value.filter((d) => d.status === "online")) {
      const result = await deviceClient(device.id)
        .searchSessions(q, "all")
        .catch(() => undefined);
      if (generation !== searchGeneration) return; // a newer query superseded this scan
      for (const match of result?.matches ?? [])
        found.push({
          deviceId: device.id,
          id: match.id,
          name: match.name,
          cwd: match.cwd,
          where: match.where,
          hits: match.hits ?? [],
        });
    }
    deviceHits.value = found;
    searching.value = false;
  }, 250);
});
const clearSearch = () => ((query.value = ""), ++searchGeneration, (deviceHits.value = []));

/** Bulk session manage (orca ManageSessionsSection): select many, then
 *  archive/abort each with a per-row result. Client-side loop over the
 *  existing APIs — no new backend surface. */
const bulkMode = ref(false);
const bulkSel = ref(new Set<string>());
const bulkBusy = ref("");
const bulkToggle = (node: TreeNode) => {
  if (node.type !== "session") return;
  const next = new Set(bulkSel.value);
  if (next.has(node.session.id)) next.delete(node.session.id);
  else next.add(node.session.id);
  bulkSel.value = next;
};
const bulkRun = async (op: "archive" | "abort") => {
  bulkBusy.value = op;
  let ok = 0;
  const failed: string[] = [];
  for (const node of rows.value.map((r) => r.node)) {
    if (node.type !== "session" || !bulkSel.value.has(node.session.id)) continue;
    const device = deviceOf(node);
    if (!device) continue;
    const client = deviceClient(device.id);
    try {
      if (op === "archive") await client.session(node.session.id).archive();
      else await client.agent(node.session.id, 1).abort(true);
      ok++;
      if (op === "archive" && selected.value?.sessionId === node.session.id) select(undefined);
    } catch {
      failed.push(node.session.name);
    }
  }
  notify(`${op}: ${ok} done${failed.length ? `, ${failed.length} failed (${failed.slice(0, 3).join(", ")})` : ""}`);
  bulkSel.value = new Set();
  bulkBusy.value = "";
};

const deviceOf = (node: TreeNode) =>
  network.devices.value.find(
    (d) => d.id === (node.type === "device" ? node.device.id : node.deviceId),
  );
const isOnline = (node: TreeNode) => deviceOf(node)?.status === "online";
const isSelected = (node: TreeNode) =>
  node.type === "agent" &&
  selected.value?.deviceId === node.deviceId &&
  selected.value.sessionId === node.sessionId &&
  selected.value.agentId === node.agent.id;

function activate(node: TreeNode) {
  focusKey.value = node.key;
  if (bulkMode.value && node.type === "session") return bulkToggle(node);
  if (node.type === "device") return toggle(node.key);
  if (node.type === "agent")
    return select({ deviceId: node.deviceId, sessionId: node.sessionId, agentId: node.agent.id });
  const root = node.session.agents.find((a) => a.kind === "root") ?? node.session.agents[0];
  toggle(node.key, true);
  if (root) select({ deviceId: node.deviceId, sessionId: node.session.id, agentId: root.id });
}

async function action(node: TreeNode, name: string) {
  const device = deviceOf(node);
  if (!device) return;
  const client = deviceClient(device.id);
  if (node.type === "device") {
    if (name === "new-session") ui.dialog = { kind: "new-session", deviceId: device.id };
    else if (name === "check") await attempt(() => hub.check(device.id));
    else if (name === "credentials") ui.dialog = { kind: "credentials", deviceId: device.id };
    return;
  }
  if (node.type === "session") {
    const s = node.session;
    if (name === "new-agent") {
      // The device API requires a name (B6); number the new agent from the tree.
      const created = await attempt(() => client.session(s.id).createAgent({ name: `Agent ${s.agents.length + 1}` }));
      if (created) {
        select({ deviceId: device.id, sessionId: s.id, agentId: created.id });
        notify("New agent. Same session, same shared App State.");
      }
    } else if (name === "rename")
      ui.dialog = {
        kind: "prompt",
        title: "Rename session",
        label: "Session name",
        value: s.name,
        submit: "Save name",
        run: (value) => client.session(s.id).rename(value),
      };
    else if (name === "worktree")
      ui.dialog = {
        kind: "prompt",
        title: "New worktree session",
        label: "Branch name",
        value: s.name.replace(/[/\\]+/g, "-"),
        hint: `Adds a sibling checkout of ${s.cwd} on the branch (git worktree add) and opens a session in it.`,
        submit: "Create worktree session",
        run: async (branch) => {
          const created = await createWorktreeSession({
            deviceApi: client,
            cwd: s.cwd,
            sessionName: branch,
            branch,
            source: s,
            catalog: device.info?.models,
            defaultModel: device.info?.defaultModel,
          });
          const root = created.agents.find((a) => a.kind === "root") ?? created.agents[0];
          select({ deviceId: device.id, sessionId: created.id, agentId: root?.id ?? 1 });
          notify(`session "${created.name}" on ${created.cwd}`);
        },
      };
    else if (name === "archive")
      ui.dialog = {
        kind: "prompt",
        title: `Archive ${s.name}?`,
        hint: `Stops all of its work and moves its files to archive/ on ${device.id}. Nothing is deleted.`,
        submit: "Archive session",
        danger: true,
        run: async () => {
          await client.session(s.id).archive();
          if (selected.value?.sessionId === s.id) select(undefined);
        },
      };
    return;
  }
  const a = node.agent;
  if (name === "rename")
    ui.dialog = {
      kind: "prompt",
      title: "Rename agent",
      label: "Agent name",
      value: a.named ? a.name : "",
      placeholder: a.name,
      submit: "Save name",
      run: (value) => client.agent(node.sessionId, a.id).rename(value),
    };
}

function move(delta: number) {
  const i = rows.value.findIndex((r) => r.node.key === focusKey.value);
  const next = rows.value[Math.max(0, Math.min(rows.value.length - 1, (i < 0 ? 0 : i) + delta))];
  if (!next) return;
  focusKey.value = next.node.key;
  void nextTick(() =>
    list.value
      ?.querySelector(`[data-key="${CSS.escape(next.node.key)}"]`)
      ?.scrollIntoView({ block: "nearest" }),
  );
}

function focusFirst() {
  focusKey.value ??= rows.value[0]?.node.key;
}

function keydown(e: KeyboardEvent) {
  const row = rows.value.find((r) => r.node.key === focusKey.value);
  if (e.key === "ArrowDown") move(1);
  else if (e.key === "ArrowUp") move(-1);
  else if (e.key === "ArrowRight" && row) {
    if (!row.node.children.length) return;
    if (expanded.value.has(row.node.key)) move(1);
    else toggle(row.node.key, true);
  } else if (e.key === "ArrowLeft" && row) {
    if (row.node.children.length && expanded.value.has(row.node.key)) toggle(row.node.key, false);
    else if (row.parent) focusKey.value = row.parent;
  } else if ((e.key === "Enter" || e.key === " ") && row) activate(row.node);
  else return;
  e.preventDefault();
}
</script>

<template>
  <aside
    class="network-sidebar"
    :class="{ open: ui.drawer, collapsed: !layout.tree && !ui.drawer }"
    aria-label="Network"
  >
    <template v-if="layout.tree || ui.drawer">
      <header class="tree-head">
        <span><Network :size="16" />NETWORK</span>
        <button
          class="icon-button"
          :aria-label="bulkMode ? 'Exit bulk select' : 'Bulk manage sessions'"
          :title="bulkMode ? 'Exit bulk select' : 'Bulk manage sessions (select → archive / abort)'"
          :class="{ on: bulkMode }"
          @click="((bulkMode = !bulkMode), (bulkSel = new Set()))"
        >
          <ListChecks :size="15" />
        </button>
        <button
          class="icon-button"
          aria-label="Pair a device"
          title="Pair a device"
          @click="ui.dialog = { kind: 'pair' }"
        >
          <Link2 :size="15" />
        </button>
        <button
          class="icon-button panel-toggle"
          aria-label="Collapse network"
          :title="`Collapse network (${panelKeys.tree})`"
          @click="((layout.tree = false), (ui.drawer = false))"
        >
          <PanelLeftClose :size="18" />
        </button>
      </header>
      <div class="tree-search">
        <Search :size="14" class="search-icon" />
        <input
          v-model="query"
          type="search"
          class="search-input"
          placeholder="Search sessions…"
          aria-label="Search sessions"
          spellcheck="false"
        />
        <button v-if="query" class="icon-button clear" aria-label="Clear search" @click="clearSearch">
          <X :size="13" />
        </button>
        <span v-if="searching" class="searching" aria-label="Searching devices">…</span>
      </div>
      <ProjectBar v-model:active="projectFilter" />
      <div
        ref="list"
        class="tree-list"
        role="tree"
        tabindex="0"
        aria-label="Devices, sessions and agents"
        @keydown="keydown"
        @focus="focusFirst"
      >
        <div v-if="bulkMode && bulkSel.size" class="bulk-bar">
          <span>{{ bulkSel.size }} selected</span>
          <button class="small" :disabled="!!bulkBusy" @click="bulkRun('abort')">abort work</button>
          <button class="small danger" :disabled="!!bulkBusy" @click="bulkRun('archive')">
            {{ bulkBusy === "archive" ? "archiving…" : "archive" }}
          </button>
        </div>
        <TreeRow
          v-for="row in localRows"
          :key="row.node.key"
          :node="row.node"
          :depth="row.depth"
          :open="expanded.has(row.node.key)"
          :selected="isSelected(row.node)"
          :focused="focusKey === row.node.key"
          :online="isOnline(row.node)"
          :checkbox="bulkMode && row.node.type === 'session'"
          :checked="row.node.type === 'session' && bulkSel.has(row.node.session.id)"
          @toggle="toggle(row.node.key)"
          @activate="activate(row.node)"
          @action="action(row.node, $event)"
          @check="bulkToggle(row.node)"
        />
        <template v-if="filtering && extraHits.length">
          <div class="hit-head hint">{{ extraHits.length }} more on device</div>
          <button
            v-for="hit in extraHits"
            :key="`${hit.deviceId}-${hit.id}`"
            class="hit"
            :title="hit.cwd"
            @click="select({ deviceId: hit.deviceId, sessionId: hit.id, agentId: 1 })"
          >
            <span class="hit-name">{{ hit.name }}</span>
            <code class="hit-cwd">{{ hit.cwd }}</code>
            <em v-if="hit.where.length" class="hit-where">{{ hit.where.join(" · ") }}</em>
            <em
              v-if="hit.hits.length"
              class="hit-line"
              :title="hit.hits.map((h) => `${h.agent} #${h.entry}: ${h.text}`).join('\n')"
            >
              {{ hit.hits[0].agent }} #{{ hit.hits[0].entry }} · {{ hit.hits[0].text.slice(0, 90) }}
            </em>
          </button>
        </template>
        <p v-if="filtering && !localRows.length && !extraHits.length" class="hint tree-empty">
          No session matches “{{ query.trim() }}”.
        </p>
        <p v-if="!rows.length && !filtering" class="hint tree-empty" data-testid="tree-empty">
          No devices yet. Declare them in <code>dpi-network.yaml</code> (start from
          <code>dpi-network.example.yaml</code>), then run <code>just net up &lt;id&gt;</code>.
        </p>
      </div>
    </template>
    <div v-else class="panel-rail" aria-label="Network (collapsed)">
      <button
        class="icon-button panel-toggle"
        aria-label="Expand network"
        :title="`Expand network (${panelKeys.tree})`"
        @click="layout.tree = true"
      >
        <PanelLeftOpen :size="18" />
      </button>
      <button
        v-for="d in network.devices.value"
        :key="d.id"
        class="rail-device"
        :title="`${d.id} · ${d.status}`"
        :aria-label="`Show ${d.id}`"
        @click="((layout.tree = true), toggle(d.id, true))"
      >
        <DeviceIcon :device="d" :size="20" /><i
          class="dot"
          :class="
            d.status === 'online'
              ? 'on'
              : d.status === 'checking'
                ? 'chk'
                : d.status === 'offline'
                  ? 'off'
                  : 'err'
          "
        />
      </button>
    </div>
  </aside>
</template>

<style scoped>
.tree-search {
  display: flex; align-items: center; gap: 0.375rem; margin: 0.25rem 0.375rem 0.125rem;
  padding: 0 0.5rem; border: 1px solid var(--line); border-radius: 0.5rem;
}
.tree-search:focus-within { border-color: var(--accent); }
.tree-search .search-icon { opacity: 0.6; flex: none; }
.search-input {
  flex: 1; min-width: 0; border: 0; background: transparent; color: var(--fg);
  font-size: 0.875rem; padding: 0.375rem 0; outline: none;
}
.search-input::-webkit-search-cancel-button { display: none; }
.tree-search .clear { padding: 0.125rem; }
.searching { opacity: 0.6; font-size: 0.8125rem; }
.hit-line {
  display: block;
  font-style: normal;
  font-size: 0.75rem;
  opacity: 0.75;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.hit-head { margin: 0.375rem 0.125rem 0.125rem; }
.hit {
  display: flex; flex-direction: column; gap: 1px; width: 100%; text-align: left;
  background: none; border: 1px solid transparent; border-radius: 0.5rem;
  padding: 0.3125rem 0.5rem; color: var(--fg); font-size: 0.9375rem; cursor: pointer;
}
.hit:hover { border-color: var(--line); background: var(--hover, rgba(127,127,127,0.08)); }
.hit-cwd { font-size: 0.75rem; opacity: 0.65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hit-where { font-style: normal; font-size: 0.6875rem; opacity: 0.5; text-transform: uppercase; letter-spacing: 0.04em; }
.bulk-bar {
  display: flex; gap: 0.5rem; align-items: center; padding: 0.375rem 0.625rem; margin: 0.25rem 0;
  border: 1px solid var(--line); border-radius: 0.5rem; font-size: 0.875rem;
}
.bulk-bar .danger { border-color: var(--warn, #e5a50a); }
</style>
