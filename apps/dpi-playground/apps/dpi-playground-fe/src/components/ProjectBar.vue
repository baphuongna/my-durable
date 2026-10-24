<script setup lang="ts">
// Projects (Wave 2): the roots sessions start in, promoted to entities you can
// name, label and archive — paseo's workspace-registry model, device-owned.
//
// The bar is a filter: click a project to narrow the tree to its sessions.
// Chips load once per online device (asked for, never polled).
import { computed, ref, watch } from "vue";
import { FolderGit2, Folder, Tag, Pencil, Archive, ArchiveRestore, X } from "lucide-vue-next";
import type { ProjectRecord } from "@sdk/api";
import { deviceClient, message } from "../client/hub";
import { network, notify, ui } from "../client/store";

interface Listed {
  deviceId: string;
  project: ProjectRecord;
  sessions: number;
}

/** v-model:active — the filter lives in the sidebar (it narrows the tree). */
const active = defineModel<{ deviceId: string; rootPath: string } | undefined>("active");
const items = ref<Listed[]>([]);
const loading = ref(false);
const failed = ref("");
const showArchived = ref(false);

const onlineIds = computed(() =>
  network.devices.value.filter((d) => d.status === "online").map((d) => d.id),
);

async function load() {
  loading.value = true;
  failed.value = "";
  const out: Listed[] = [];
  const errors: string[] = [];
  for (const id of onlineIds.value) {
    const device = network.devices.value.find((d) => d.id === id);
    const result = await deviceClient(id)
      .projects(showArchived.value)
      .catch((e) => {
        // A device on an older build has no /projects route (it answers 404, or
        // its own allowlist refuses the route). That is not an error the human
        // can act on, so it is not shown — the project list is just shorter.
        const text = message(e);
        const stale = (e as { code?: string }).code === "not_found" || /allowlist|not found/i.test(text);
        if (!stale) errors.push(`${id}: ${text.slice(0, 60)}`);
        return undefined;
      });
    for (const project of result?.projects ?? []) {
      const sessions = (device?.tree?.sessions ?? []).filter(
        (s) => s.cwd === project.rootPath || s.cwd.startsWith(`${project.rootPath}/`),
      ).length;
      out.push({ deviceId: id, project, sessions });
    }
  }
  items.value = out.sort((a, b) => display(a.project).localeCompare(display(b.project)));
  if (errors.length) failed.value = errors.join(" · ");
  loading.value = false;
}

watch([onlineIds, showArchived], load, { immediate: true });

const display = (project: ProjectRecord) => project.customName ?? project.name;
const isActive = (item: Listed) =>
  active.value?.deviceId === item.deviceId && active.value.rootPath === item.project.rootPath;

function toggle(item: Listed) {
  active.value = isActive(item) ? undefined : { deviceId: item.deviceId, rootPath: item.project.rootPath };
}

/** Two separate app-styled prompts (not chained: the dialog closes after each run). */
function rename(item: Listed) {
  const project = item.project;
  ui.dialog = {
    kind: "prompt",
    title: `Rename ${display(project)}`,
    label: "Project name",
    hint: "Shown in the tree and in usage rollups. Leave empty to use the folder name.",
    value: project.customName ?? "",
    placeholder: project.name,
    submit: "Save name",
    run: async (value) => {
      const updated = await deviceClient(item.deviceId).updateProject(project.id, { customName: value });
      notify(`Project renamed to ${updated.customName ?? updated.name}.`);
      await load();
    },
  };
}

function labels(item: Listed) {
  const project = item.project;
  ui.dialog = {
    kind: "prompt",
    title: `Labels for ${display(project)}`,
    label: "Labels (comma separated)",
    hint: "Lowercase, up to 12 labels of 32 characters. Used to filter projects.",
    value: project.labels.join(", "),
    submit: "Save labels",
    run: async (value) => {
      const updated = await deviceClient(item.deviceId).updateProject(project.id, {
        labels: value
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean),
      });
      notify(
        updated.labels.length ? `Labels: ${updated.labels.join(", ")}.` : `Labels cleared on ${display(updated)}.`,
      );
      await load();
    },
  };
}

function archive(item: Listed) {
  const project = item.project;
  const archived = project.archivedAt !== null;
  ui.dialog = {
    kind: "prompt",
    title: `${archived ? "Restore" : "Archive"} ${display(project)}?`,
    hint: archived
      ? "The project returns to the tree. Its sessions were never touched."
      : "Bookkeeping only: the project leaves the list, its sessions keep running. Nothing is deleted.",
    submit: archived ? "Restore project" : "Archive project",
    danger: !archived,
    run: async () => {
      const client = deviceClient(item.deviceId);
      if (archived) await client.unarchiveProject(project.id);
      else await archiveAt(client, project.id);
      if (!archived && isActive(item)) active.value = undefined;
      await load();
    },
  };
}

const archiveAt = (client: ReturnType<typeof deviceClient>, id: string) => client.archiveProject(id);

defineExpose({ reload: load });
</script>

<template>
  <div class="project-bar" aria-label="Projects">
    <div class="project-head">
      <span class="project-title"><FolderGit2 :size="13" />PROJECTS</span>
      <button
        class="icon-button tiny"
        :class="{ on: showArchived }"
        :aria-label="showArchived ? 'Hide archived projects' : 'Show archived projects'"
        :title="showArchived ? 'Hide archived projects' : 'Show archived projects'"
        @click="showArchived = !showArchived"
      >
        <Archive :size="12" />
      </button>
      <span v-if="loading" class="project-hint">…</span>
    </div>
    <div v-if="items.length" class="chips">
      <button
        v-for="item in items"
        :key="`${item.deviceId}-${item.project.id}`"
        class="chip"
        :class="{ on: isActive(item), archived: item.project.archivedAt }"
        :title="`${item.project.rootPath} — ${item.sessions} session${item.sessions === 1 ? '' : 's'}`"
        @click="toggle(item)"
        @dblclick="rename(item)"
      >
        <Folder v-if="item.project.kind === 'plain'" :size="11" />
        <FolderGit2 v-else :size="11" />
        <span class="chip-name">{{ display(item.project) }}</span>
        <em class="chip-count">{{ item.sessions }}</em>
        <span v-for="label in item.project.labels.slice(0, 2)" :key="label" class="chip-label">{{ label }}</span>
      </button>
    </div>
    <p v-else-if="!loading" class="project-hint">
      No projects yet — a project appears when a session starts in a folder.
    </p>

    <div v-if="active" class="project-actions">
      <span class="project-hint">filtering</span>
      <template v-for="item in items.filter(isActive)" :key="item.project.id">
        <button class="small" @click="rename(item)"><Pencil :size="12" />name</button>
        <button class="small" @click="labels(item)"><Tag :size="12" />labels</button>
        <button class="small" @click="archive(item)">
          <ArchiveRestore v-if="item.project.archivedAt" :size="12" />
          <Archive v-else :size="12" />
          {{ item.project.archivedAt ? "restore" : "archive" }}
        </button>
        <button class="icon-button tiny" aria-label="Clear project filter" @click="active = undefined">
          <X :size="12" />
        </button>
      </template>
    </div>
    <p v-if="failed" class="message-error">{{ failed }}</p>
    <p v-if="items.some((i) => i.project.labels.length)" class="project-hint labels-hint">
      <Tag :size="11" />labels: {{ [...new Set(items.flatMap((i) => i.project.labels))].join(" · ") }}
    </p>
  </div>
</template>

<style scoped>
.project-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 2px 6px 4px;
}
.project-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.project-title {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  letter-spacing: 0.06em;
  opacity: 0.6;
}
.project-hint {
  font-size: 13px;
  opacity: 0.6;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--fg);
  font-size: 14px;
  cursor: pointer;
}
.chip:hover {
  border-color: var(--accent);
}
.chip.on {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.chip.archived {
  opacity: 0.55;
}
.chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}
.chip-count {
  font-style: normal;
  font-size: 11px;
  opacity: 0.65;
  font-variant-numeric: tabular-nums;
}
.chip-label {
  font-size: 11px;
  padding: 0 5px;
  border-radius: 6px;
  border: 1px solid var(--line);
  opacity: 0.75;
}
.project-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.icon-button.tiny {
  padding: 2px;
}
.labels-hint {
  flex-wrap: wrap;
}
</style>
