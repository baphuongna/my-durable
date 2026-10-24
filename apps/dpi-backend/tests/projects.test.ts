/**
 * Wave 2 of docs/host-project-checklist.md: the project registry (entity +
 * labels + archive). The file is the contract other processes read, so every
 * test that mutates also looks at the bytes on disk — a registry that only
 * remembers in RAM is worse than none.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_LABELS,
  MAX_LABEL_LENGTH,
  ProjectRegistry,
  ProjectRegistryError,
  deriveProjectName,
  migrate,
  normaliseLabels,
  normaliseRootPath,
} from "../src/projects.js";

const mode = (path: string) => stat(path).then((stats) => stats.mode & 0o777);

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "dpi-projects-"));
  const dataDir = join(root, "data");
  return {
    root,
    dataDir,
    file: join(dataDir, "projects.json"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** `open` with the warnings captured, so recovery is asserted instead of printed. */
function openWith(file: string, warnings: string[] = [], now?: () => string) {
  return ProjectRegistry.open(file, {
    warn: (message) => warnings.push(message),
    ...(now ? { now } : {}),
  });
}

const readFileJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));

test("ensure is idempotent per rootPath and lands one record on disk", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file);
    const first = await registry.ensure({ rootPath: join(s.root, "work", "app"), kind: "git" });
    const second = await registry.ensure({ rootPath: `${join(s.root, "work", "app")}/`, kind: "git" });

    assert.equal(first.id, second.id, "same directory, same project");
    assert.match(first.id, /^prj_[0-9a-f]{12}$/);
    assert.equal(first.rootPath, join(s.root, "work", "app"), "trailing separator stripped");
    assert.equal(first.name, "app", "display name derived from the directory");
    assert.deepEqual(first.labels, []);
    assert.equal(first.archivedAt, null);
    assert.equal(registry.list().length, 1);

    const onDisk = await readFileJson(s.file);
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.projects.length, 1);
    assert.equal(onDisk.projects[0].id, first.id);

    // A reopen reads the same project back (not a second one).
    const reopened = await openWith(s.file);
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.findByPath(join(s.root, "work", "app"))?.id, first.id);
  } finally {
    await s.cleanup();
  }
});

test("ensure refreshes kind when a plain directory becomes a git repo", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file);
    const plain = await registry.ensure({ rootPath: join(s.root, "repo"), kind: "plain" });
    assert.equal(plain.kind, "plain");

    const git = await registry.ensure({ rootPath: join(s.root, "repo"), kind: "git" });
    assert.equal(git.id, plain.id, "still the same project");
    assert.equal(git.kind, "git");
    assert.equal(registry.list().length, 1);
    assert.equal((await readFileJson(s.file)).projects[0].kind, "git");

    // An unknown kind is a caller bug, not something to store.
    await assert.rejects(
      () => registry.ensure({ rootPath: join(s.root, "repo"), kind: "svn" as never }),
      (error: unknown) => error instanceof ProjectRegistryError && error.code === "invalid",
    );
  } finally {
    await s.cleanup();
  }
});

test("labels are lowercased, trimmed, de-duplicated and validated", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file);
    const project = await registry.ensure({ rootPath: join(s.root, "lab"), kind: "git" });

    const updated = await registry.update(project.id, {
      labels: ["Bug", " bug ", "needs review", "v2-migration", "ops_team"],
    });
    assert.deepEqual(updated.labels, ["bug", "needs review", "v2-migration", "ops_team"]);

    const tooMany = Array.from({ length: MAX_LABELS + 1 }, (_, index) => `l${index}`);
    await assert.rejects(() => registry.update(project.id, { labels: tooMany }), /limit is 12/);
    await assert.rejects(
      () => registry.update(project.id, { labels: ["x".repeat(MAX_LABEL_LENGTH + 1)] }),
      /the limit is 32/,
    );
    await assert.rejects(() => registry.update(project.id, { labels: ["bad!"] }), /only a-z, 0-9/);
    await assert.rejects(() => registry.update(project.id, { labels: ["-leading"] }), /only a-z, 0-9/);
    await assert.rejects(() => registry.update(project.id, { labels: ["ok", 7 as never] }), /must be strings/);

    // Duplicates do not count against the cap, and blanks are not labels.
    const exactlyLimit = Array.from({ length: MAX_LABELS }, (_, index) => `l${index}`);
    const capped = await registry.update(project.id, { labels: [...exactlyLimit, ...exactlyLimit, "  "] });
    assert.equal(capped.labels.length, MAX_LABELS);
    assert.deepEqual(normaliseLabels(["A", "a", ""]), ["a"]);

    // Rejected input leaves the stored record untouched.
    assert.deepEqual(registry.get(project.id)?.labels, exactlyLimit);
    await assert.rejects(() => registry.update("prj_000000000000", { labels: [] }), /no project/);
  } finally {
    await s.cleanup();
  }
});

test("customName is set, cleared, and never overwritten by ensure", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file);
    const project = await registry.ensure({ rootPath: join(s.root, "plain-repo-name"), kind: "git" });

    const named = await registry.update(project.id, { customName: "  Payments service  " });
    assert.equal(named.customName, "Payments service");
    assert.equal(named.name, "plain-repo-name", "the derived name stays as detected");

    const resighted = await registry.ensure({ rootPath: join(s.root, "plain-repo-name"), kind: "plain" });
    assert.equal(resighted.customName, "Payments service", "reconciliation leaves the override alone");

    const cleared = await registry.update(project.id, { customName: "" });
    assert.equal(cleared.customName, undefined);
    assert.equal("customName" in cleared, false, "clearing removes the key instead of storing an empty string");
    assert.equal((await readFileJson(s.file)).projects[0].customName, undefined);

    await assert.rejects(
      () => registry.update(project.id, { customName: "x".repeat(81) }),
      /the limit is 80/,
    );
  } finally {
    await s.cleanup();
  }
});

test("archive hides a project from list, unarchive restores it, ensure does not resurrect it", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file);
    const project = await registry.ensure({ rootPath: join(s.root, "old"), kind: "git" });
    await registry.update(project.id, { labels: ["legacy"] });

    const archived = await registry.archive(project.id);
    assert.ok(archived.archivedAt, "archive stamps archivedAt");
    assert.deepEqual(registry.list(), [], "archived projects are out of the default list");
    assert.equal(registry.list({ includeArchived: true }).length, 1);
    assert.equal((await readFileJson(s.file)).projects[0].archivedAt, archived.archivedAt);

    // Re-stamping would lose the truth of when it went away.
    const again = await registry.archive(project.id);
    assert.equal(again.archivedAt, archived.archivedAt);

    // A session cwd showing up again is not a request to un-archive.
    const resighted = await registry.ensure({ rootPath: join(s.root, "old"), kind: "git" });
    assert.equal(resighted.id, project.id);
    assert.equal(resighted.archivedAt, archived.archivedAt, "still archived");
    assert.deepEqual(registry.list(), [], "and still hidden");

    const restored = await registry.unarchive(project.id);
    assert.equal(restored.archivedAt, null);
    assert.deepEqual(restored.labels, ["legacy"], "a soft delete keeps the labels");
    assert.deepEqual(
      registry.list().map((record) => record.id),
      [project.id],
    );
    await assert.rejects(() => registry.unarchive("prj_000000000000"), /no project/);
  } finally {
    await s.cleanup();
  }
});

test("list sorts by the name a human reads", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file);
    const zebra = await registry.ensure({ rootPath: join(s.root, "zebra"), kind: "git" });
    await registry.ensure({ rootPath: join(s.root, "alpha"), kind: "git" });
    assert.deepEqual(
      registry.list().map((record) => record.name),
      ["alpha", "zebra"],
    );

    // The override wins over the derived name — that is what the row shows.
    await registry.update(zebra.id, { customName: "abc projects" });
    assert.deepEqual(
      registry.list().map((record) => record.customName ?? record.name),
      ["abc projects", "alpha"],
      "the override is what sorts and what the row shows",
    );
    assert.equal(registry.list()[0]?.id, zebra.id, "customName sorts first");
  } finally {
    await s.cleanup();
  }
});

test("a v0 registry (rootPath-keyed map) migrates and keeps names and labels", async () => {
  const s = await scratch();
  try {
    await mkdir(s.dataDir, { recursive: true, mode: 0o700 });
    await writeFile(
      s.file,
      JSON.stringify({
        projects: {
          "/srv/checkout": { name: "Checkout", labels: ["Bug", "ops"] },
          "/srv/api": { name: "api", labels: [] },
        },
      }),
      "utf8",
    );

    const warnings: string[] = [];
    const registry = await openWith(s.file, warnings);
    const byPath = registry.list();

    assert.equal(byPath.length, 2, "no record was dropped");
    const checkout = registry.findByPath("/srv/checkout");
    assert.equal(checkout?.name, "checkout", "derived name from the directory");
    assert.equal(checkout?.customName, "Checkout", "the legacy name was user-meaningful, so it survives as an override");
    assert.deepEqual(checkout?.labels, ["bug", "ops"], "labels kept, lowercased");
    assert.equal(checkout?.kind, "plain");
    assert.match(checkout?.id ?? "", /^prj_[0-9a-f]{12}$/);

    const api = registry.findByPath("/srv/api");
    assert.equal(api?.customName, undefined, "a legacy name equal to the directory name is not an override");
    assert.equal(api?.name, "api");

    // The next mutation writes v1: the migration is durable, not just in memory.
    await registry.update(checkout!.id, { labels: ["bug"] });
    const onDisk = await readFileJson(s.file);
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.projects.length, 2);

    // migrate() is pure and refuses a shape it does not know, rather than guessing.
    assert.throws(() => migrate({ version: 2, projects: [] }), /unsupported registry version 2/);
    assert.deepEqual(migrate({ version: 1, projects: [] }), []);
    assert.deepEqual(warnings, [], "a clean v0 file is not a warning");
  } finally {
    await s.cleanup();
  }
});

test("a corrupt main file falls back to the .bak copy", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file);
    const keep = await registry.ensure({ rootPath: join(s.root, "keep"), kind: "git" });
    // Second write creates the .bak of the first good file.
    await registry.ensure({ rootPath: join(s.root, "later"), kind: "git" });
    assert.equal((await readFileJson(`${s.file}.bak`)).projects.length, 1);

    await writeFile(s.file, "{ this is not json", "utf8");

    const warnings: string[] = [];
    const reopened = await openWith(s.file, warnings);
    assert.deepEqual(
      reopened.list().map((record) => record.id),
      [keep.id],
      "the backup's project came back",
    );
    assert.ok(
      warnings.some((line) => line.includes("unusable")),
      `the recovery was reported: ${JSON.stringify(warnings)}`,
    );
    const names = await readdir(s.dataDir);
    assert.ok(
      names.some((name) => name.startsWith("projects.json.corrupt-")),
      "the corrupt file was kept aside, not deleted",
    );
  } finally {
    await s.cleanup();
  }
});

test("main and .bak both corrupt → empty registry, bad file moved aside", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file);
    await registry.ensure({ rootPath: join(s.root, "gone"), kind: "git" });
    await registry.ensure({ rootPath: join(s.root, "gone2"), kind: "git" });
    await writeFile(s.file, "garbage", "utf8");
    await writeFile(`${s.file}.bak`, "\u0000\u0001 also garbage", "utf8");

    const warnings: string[] = [];
    const reopened = await openWith(s.file, warnings);
    assert.deepEqual(reopened.list(), []);
    assert.ok(warnings.some((line) => line.includes("unusable")));
    assert.ok(warnings.some((line) => line.includes("unusable too")));

    const names = await readdir(s.dataDir);
    assert.ok(names.some((name) => name.startsWith("projects.json.corrupt-")));
    assert.equal(names.includes("projects.json"), false, "the torn file is no longer the registry");

    // A recovered-from-nothing registry still works, and the good .bak was not clobbered on the way.
    const project = await reopened.ensure({ rootPath: join(s.root, "fresh"), kind: "plain" });
    assert.equal(reopened.list().length, 1);
    assert.equal((await readFileJson(s.file)).projects[0].id, project.id);
  } finally {
    await s.cleanup();
  }
});

test("every mutation writes atomically with 0600 and leaves no temp file behind", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file);
    const project = await registry.ensure({ rootPath: join(s.root, "secure"), kind: "git" });
    await registry.update(project.id, { labels: ["ops"], customName: "Secure" });
    await registry.archive(project.id);

    const parsed = await readFileJson(s.file);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.projects.length, 1);
    assert.equal(parsed.projects[0].customName, "Secure");

    assert.equal(await mode(s.file), 0o600, "registry file is owner-only");
    assert.equal(await mode(s.dataDir), 0o700, "its directory is owner-only");
    assert.equal(await mode(`${s.file}.bak`), 0o600, "the backup is owner-only too");

    const names = await readdir(s.dataDir);
    assert.deepEqual(
      names.filter((name) => name.includes(".tmp-")),
      [],
      "renames leave no temp files",
    );

    // remove is a real delete; the file reflects it immediately.
    assert.equal(await registry.remove(project.id), true);
    assert.equal(await registry.remove(project.id), false, "removing a missing project is a no-op");
    assert.deepEqual((await readFileJson(s.file)).projects, []);
  } finally {
    await s.cleanup();
  }
});

test("findByPath normalises trailing separators, and name derivation is separator-agnostic", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file);
    const project = await registry.ensure({ rootPath: "/a/b", kind: "git" });

    assert.equal(registry.findByPath("/a/b/")?.id, project.id);
    assert.equal(registry.findByPath("/a/b///")?.id, project.id);
    assert.equal(registry.findByPath("/a/b/./")?.id, project.id);
    assert.equal(registry.findByPath("/a/b/c"), undefined, "a subdirectory is a different path");
    assert.equal(registry.findByPath("/a"), undefined);

    assert.equal(normaliseRootPath("/a/b/"), "/a/b");
    assert.equal(deriveProjectName("/a/b/"), "b");
    assert.equal(deriveProjectName("/"), "/");
    assert.equal(deriveProjectName("C:\\work\\repo"), "repo");
    assert.throws(() => normaliseRootPath("   "), /rootPath is required/);
  } finally {
    await s.cleanup();
  }
});

test("records are returned as copies, so a caller cannot mutate the cache", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file);
    const project = await registry.ensure({ rootPath: join(s.root, "copy"), kind: "git" });
    await registry.update(project.id, { labels: ["ops"] });

    const listed = registry.list()[0]!;
    listed.labels.push("hacked");
    listed.name = "hacked";
    assert.deepEqual(registry.get(project.id)?.labels, ["ops"]);
    assert.equal(registry.get(project.id)?.name, "copy");
  } finally {
    await s.cleanup();
  }
});

test("concurrent ensures on one path still produce a single project", async () => {
  const s = await scratch();
  try {
    const registry = await openWith(s.file);
    const rootPath = join(s.root, "race");
    const created = await Promise.all(
      Array.from({ length: 8 }, () => registry.ensure({ rootPath, kind: "git" })),
    );

    assert.equal(new Set(created.map((record) => record.id)).size, 1, "one id for one directory");
    assert.equal(registry.list().length, 1);
    assert.equal((await readFileJson(s.file)).projects.length, 1, "and one record on disk");
  } finally {
    await s.cleanup();
  }
});
