import { createHash } from "node:crypto";
import { access, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  NoteDetail,
  NoteSummary,
  PluginManifestSummary,
  VaultDetail,
  VaultSummary
} from "@obsidian-web-local/shared";
import { getExtensionContributions, notifyNoteSaved } from "./extension-host.js";
import { classifyPluginManifest } from "./plugin-host.js";

const MARKDOWN_EXTENSION = ".md";
const OBSIDIAN_FOLDER = ".obsidian";
const PLUGIN_FOLDER = "plugins";
const DAILY_WORK_REPORT_PROJECT_NAMES = path.join("daily-work-report", "config", "project_names.json");

function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function loadProjectNames(vaultPath: string): Promise<Record<string, string>> {
  const candidates = [
    path.join(path.dirname(vaultPath), DAILY_WORK_REPORT_PROJECT_NAMES),
    path.join(path.dirname(path.dirname(vaultPath)), DAILY_WORK_REPORT_PROJECT_NAMES),
    path.join(os.homedir(), "Code", DAILY_WORK_REPORT_PROJECT_NAMES)
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed)
          .map(([key, value]) => [String(key).trim(), String(value).trim()] as const)
          .filter(([key, value]) => key && value)
      );
    } catch {
      // daily-work-report is optional for generic vaults.
    }
  }

  return {};
}

async function isVaultDirectory(candidatePath: string): Promise<boolean> {
  return pathExists(path.join(candidatePath, OBSIDIAN_FOLDER));
}

async function listDirectories(parentPath: string): Promise<string[]> {
  const entries = await readdir(parentPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(parentPath, entry.name));
}

async function discoverVaultPaths(): Promise<string[]> {
  const rawRoots = process.env.OBS_VAULT_ROOTS ?? `${os.homedir()}/Documents/Obsidian`;
  const roots = rawRoots
    .split(path.delimiter)
    .map((segment) => expandHome(segment.trim()))
    .filter(Boolean);
  const discovered = new Set<string>();

  for (const root of roots) {
    if (!(await pathExists(root))) {
      continue;
    }

    if (await isVaultDirectory(root)) {
      discovered.add(root);
      continue;
    }

    const children = await listDirectories(root);
    for (const child of children) {
      if (await isVaultDirectory(child)) {
        discovered.add(child);
      }
    }
  }

  return [...discovered].sort((left, right) => left.localeCompare(right));
}

async function collectMarkdownFiles(vaultPath: string, currentPath = vaultPath): Promise<string[]> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === OBSIDIAN_FOLDER || entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }

    const fullPath = path.join(currentPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(vaultPath, fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION)) {
      files.push(fullPath);
    }
  }

  return files;
}

async function resolveVaultPath(vaultId: string): Promise<{ id: string; vaultPath: string } | null> {
  const vaultPaths = await discoverVaultPaths();

  for (const vaultPath of vaultPaths) {
    const id = createHash("sha1").update(vaultPath).digest("hex").slice(0, 12);
    if (id === vaultId) {
      return { id, vaultPath };
    }
  }

  return null;
}

function normalizeResolvedVaultPath(vaultPath: string, candidatePath: string): string | null {
  const resolvedPath = path.resolve(vaultPath, candidatePath);
  const vaultRoot = path.resolve(vaultPath);
  const normalizedVaultPrefix = `${vaultRoot}${path.sep}`;

  if (resolvedPath !== vaultRoot && !resolvedPath.startsWith(normalizedVaultPrefix)) {
    return null;
  }

  return resolvedPath;
}

async function buildNoteSummary(vaultPath: string, filePath: string): Promise<NoteSummary> {
  const relativePath = path.relative(vaultPath, filePath);
  const content = await readFile(filePath, "utf8");

  return {
    path: relativePath,
    title: path.basename(filePath, MARKDOWN_EXTENSION),
    viewTypes: detectNoteViewTypes(relativePath, content)
  };
}

function stampUpdatedFrontmatter(content: string): string {
  if (!content.startsWith("---\n")) {
    return content;
  }

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return content;
  }

  const timestamp = new Date().toISOString().slice(0, 10);
  const block = frontmatterMatch[1] ?? "";
  const nextBlock = /^updated:\s*.+$/m.test(block)
    ? block.replace(/^updated:\s*.+$/m, `updated: ${timestamp}`)
    : `${block}\nupdated: ${timestamp}`;

  return content.replace(frontmatterMatch[0], `---\n${nextBlock}\n---`);
}

function detectNoteViewTypes(notePath: string, content: string): string[] {
  const viewTypes = new Set<string>(["markdown"]);

  if (/^---[\s\S]*?\bkanban-plugin:\s*board\b[\s\S]*?---/m.test(content)) {
    viewTypes.add("kanban");
  }

  if (/^%%\s*kanban:settings/m.test(content)) {
    viewTypes.add("kanban");
  }

  if (notePath.endsWith(".canvas")) {
    viewTypes.add("canvas");
  }

  return [...viewTypes];
}

async function collectPluginManifests(vaultPath: string): Promise<PluginManifestSummary[]> {
  const pluginsRoot = path.join(vaultPath, OBSIDIAN_FOLDER, PLUGIN_FOLDER);
  const enabledPluginsPath = path.join(vaultPath, OBSIDIAN_FOLDER, "community-plugins.json");
  let enabledPlugins = new Set<string>();

  if (await pathExists(enabledPluginsPath)) {
    try {
      const enabledPluginsText = await readFile(enabledPluginsPath, "utf8");
      const enabledPluginIds = JSON.parse(enabledPluginsText) as string[];
      enabledPlugins = new Set(enabledPluginIds);
    } catch {
      enabledPlugins = new Set<string>();
    }
  }

  if (!(await pathExists(pluginsRoot))) {
    return [];
  }

  const pluginDirs = await listDirectories(pluginsRoot);
  const manifests = await Promise.all(
    pluginDirs.map(async (pluginDir) => {
      const manifestPath = path.join(pluginDir, "manifest.json");
      const mainEntryPath = path.join(pluginDir, "main.js");

      if (!(await pathExists(manifestPath))) {
        return null;
      }

      try {
        const manifestText = await readFile(manifestPath, "utf8");
        const manifestJson = JSON.parse(manifestText) as {
          id?: string;
          name?: string;
          version?: string;
          description?: string;
        };
        const id = manifestJson.id ?? path.basename(pluginDir);
        const name = manifestJson.name ?? id;
        const description = manifestJson.description;
        const mainEntryExists = await pathExists(mainEntryPath);
        const mainEntrySource = mainEntryExists ? await readFile(mainEntryPath, "utf8") : undefined;
        const classification = classifyPluginManifest({
          id,
          name,
          ...(description ? { description } : {}),
          mainEntryExists,
          ...(mainEntrySource ? { mainEntrySource } : {})
        });

        return {
          id,
          name,
          version: manifestJson.version ?? "unknown",
          ...(description ? { description } : {}),
          enabled: enabledPlugins.size === 0 ? true : enabledPlugins.has(id),
          compatibility: classification.compatibility,
          compatibilityReasons: classification.compatibilityReasons
        } satisfies PluginManifestSummary;
      } catch {
        return {
          id: path.basename(pluginDir),
          name: path.basename(pluginDir),
          version: "unknown",
          description: "Manifest could not be parsed",
          enabled: false,
          compatibility: "unsupported",
          compatibilityReasons: ["manifest could not be parsed"]
        } satisfies PluginManifestSummary;
      }
    })
  );

  return manifests.filter((manifest): manifest is PluginManifestSummary => manifest !== null);
}

export async function listVaults(): Promise<VaultSummary[]> {
  const vaultPaths = await discoverVaultPaths();
  const summaries = await Promise.all(
    vaultPaths.map(async (vaultPath) => {
      const markdownFiles = await collectMarkdownFiles(vaultPath);
      const pluginManifests = await collectPluginManifests(vaultPath);
      const name = path.basename(vaultPath);

      return {
        id: createHash("sha1").update(vaultPath).digest("hex").slice(0, 12),
        name,
        path: vaultPath,
        noteCount: markdownFiles.length,
        pluginCount: pluginManifests.length
      } satisfies VaultSummary;
    })
  );

  return summaries;
}

export async function getVaultDetail(vaultId: string): Promise<VaultDetail | null> {
  const resolved = await resolveVaultPath(vaultId);
  if (!resolved) {
    return null;
  }

  const { id, vaultPath } = resolved;
  const [markdownFiles, pluginManifests] = await Promise.all([
    collectMarkdownFiles(vaultPath),
    collectPluginManifests(vaultPath)
  ]);
  const extensionContributions = await getExtensionContributions(vaultPath, pluginManifests);

  return {
    id,
    name: path.basename(vaultPath),
    path: vaultPath,
    projectNames: await loadProjectNames(vaultPath),
    notes: (await Promise.all(markdownFiles.map((filePath) => buildNoteSummary(vaultPath, filePath)))).sort((left, right) =>
      left.path.localeCompare(right.path)
    ),
    pluginManifests,
    extensionContributions
  };
}

export async function getNoteDetail(vaultId: string, notePath: string): Promise<NoteDetail | null> {
  const resolved = await resolveVaultPath(vaultId);
  if (!resolved) {
    return null;
  }

  const resolvedPath = normalizeResolvedVaultPath(resolved.vaultPath, notePath);
  if (!resolvedPath || !(await pathExists(resolvedPath))) {
    return null;
  }

  const content = await readFile(resolvedPath, "utf8");
  const stats = await stat(resolvedPath);

  return {
    path: notePath,
    title: path.basename(resolvedPath, MARKDOWN_EXTENSION),
    viewTypes: detectNoteViewTypes(notePath, content),
    content,
    updatedAt: stats.mtime.toISOString()
  };
}

export async function updateNoteDetail(
  vaultId: string,
  notePath: string,
  content: string
): Promise<{ note: NoteDetail; notices: string[] } | null> {
  const resolved = await resolveVaultPath(vaultId);
  if (!resolved) {
    return null;
  }

  const resolvedPath = normalizeResolvedVaultPath(resolved.vaultPath, notePath);
  if (!resolvedPath || !(await pathExists(resolvedPath))) {
    return null;
  }

  const nextContent = stampUpdatedFrontmatter(content);
  await writeFile(resolvedPath, nextContent, "utf8");

  const pluginManifests = await collectPluginManifests(resolved.vaultPath);
  const notices = await notifyNoteSaved(resolved.vaultPath, pluginManifests, notePath);
  const note = await getNoteDetail(vaultId, notePath);

  if (!note) {
    return null;
  }

  return { note, notices };
}
