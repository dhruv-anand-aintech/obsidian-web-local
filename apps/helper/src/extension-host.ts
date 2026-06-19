import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExtensionActionRequest,
  ExtensionActionResponse,
  ExtensionContribution,
  PluginManifestSummary
} from "@obsidian-web-local/shared";

const BOARD_PATH = "PROJECTS-KANBAN.md";
const FOCUS_LOG_PATH = "Focus-Time-Log.md";
const BOARD_AUTOCOMMIT_DEBOUNCE_MS = 10_000;
const DEFAULT_CODEX_SETTINGS = {
  codexPath: process.env.CODEX_PATH ?? "codex",
  defaultMaxEdits: 3,
  extraInstructions: "",
  preferITerm: false
};

type BoardEntry = {
  name: string;
  section: string;
  parent: string | null;
  importance: string | null;
  complexity: string | null;
};

type BoardChanges = {
  added: string[];
  removed: string[];
  moved: Array<{ name: string; from: string; to: string }>;
  reparents: Array<{ name: string; from: string | null; to: string | null }>;
  attrChanges: Array<{ name: string; parts: string[] }>;
};

type CodexBoardBarSettings = typeof DEFAULT_CODEX_SETTINGS & {
  workspaceRoot: string;
  boardPath: string;
};

type FocusQueueItem = {
  project: string;
  note: string;
  durationMinutes: number;
};

type FocusTimerState = {
  durationMinutes: number;
  logPath: string;
  queue: FocusQueueItem[];
  current: null | {
    project: string;
    note: string;
    durationMinutes: number;
    startedAt: string;
    endsAt: string;
  };
};

type BrowserExtensionAdapterContext = {
  vaultPath: string;
  repoPath: string;
  enabledPlugins: Set<string>;
  pluginManifests: PluginManifestSummary[];
};

type BrowserExtensionAdapter = {
  pluginId: string;
  getContribution?: (context: BrowserExtensionAdapterContext) => Promise<ExtensionContribution | null>;
  onNoteSaved?: (
    context: BrowserExtensionAdapterContext,
    notePath: string
  ) => Promise<string[]>;
  invokeAction?: (
    context: BrowserExtensionAdapterContext,
    action: ExtensionActionRequest
  ) => Promise<ExtensionActionResponse>;
};

const pendingBoardCommitTimers = new Map<string, NodeJS.Timeout>();

function execFileAsync(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, maxBuffer: 1024 * 1024 * 8 }, (error, stdout, stderr) => {
      if (error) {
        reject(
          Object.assign(error, {
            stdout,
            stderr
          })
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function parseAttrs(text: string) {
  const importance = text.match(/\[I:([^\]]+)\]/)?.[1] ?? null;
  const complexity = text.match(/\[C:([^\]]+)\]/)?.[1] ?? null;
  return { importance, complexity };
}

function parseBoard(markdown: string): Map<string, BoardEntry> {
  const lines = markdown.split(/\r?\n/);
  const entries = new Map<string, BoardEntry>();
  let section = "";
  let parent: string | null = null;

  for (const line of lines) {
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      section = heading[1] ?? "";
      parent = null;
      continue;
    }

    const top = line.match(/^- \[[^[]*\] \[\[([^|\]]+)/);
    if (top) {
      const name = top[1] ?? "";
      parent = name;
      entries.set(name, {
        name,
        section,
        parent: null,
        ...parseAttrs(line)
      });
      continue;
    }

    const child = line.match(/^\s+- child: \[\[([^|\]]+)/);
    if (child) {
      const name = child[1] ?? "";
      entries.set(name, {
        name,
        section,
        parent,
        ...parseAttrs(line)
      });
    }
  }

  return entries;
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function summarizeChanges(oldBoard: Map<string, BoardEntry>, newBoard: Map<string, BoardEntry>): BoardChanges {
  const added: string[] = [];
  const removed: string[] = [];
  const moved: BoardChanges["moved"] = [];
  const reparents: BoardChanges["reparents"] = [];
  const attrChanges: BoardChanges["attrChanges"] = [];

  for (const [name, nextEntry] of newBoard.entries()) {
    const prevEntry = oldBoard.get(name);
    if (!prevEntry) {
      added.push(name);
      continue;
    }

    if (prevEntry.section !== nextEntry.section) {
      moved.push({ name, from: prevEntry.section, to: nextEntry.section });
    }

    if ((prevEntry.parent ?? null) !== (nextEntry.parent ?? null)) {
      reparents.push({ name, from: prevEntry.parent ?? null, to: nextEntry.parent ?? null });
    }

    const parts: string[] = [];
    if (prevEntry.importance !== nextEntry.importance) {
      parts.push(`importance ${prevEntry.importance ?? "-"} -> ${nextEntry.importance ?? "-"}`);
    }
    if (prevEntry.complexity !== nextEntry.complexity) {
      parts.push(`complexity ${prevEntry.complexity ?? "-"} -> ${nextEntry.complexity ?? "-"}`);
    }
    if (parts.length > 0) {
      attrChanges.push({ name, parts });
    }
  }

  for (const name of oldBoard.keys()) {
    if (!newBoard.has(name)) {
      removed.push(name);
    }
  }

  return { added, removed, moved, reparents, attrChanges };
}

function summarizeMany(changes: BoardChanges) {
  const parts: string[] = [];

  if (changes.moved.length > 0) {
    parts.push(`move ${changes.moved.length} ${pluralize(changes.moved.length, "project")}`);
  }
  if (changes.reparents.length > 0) {
    parts.push(`reparent ${changes.reparents.length} ${pluralize(changes.reparents.length, "project")}`);
  }
  if (changes.attrChanges.length > 0) {
    parts.push(`update ${changes.attrChanges.length} ${pluralize(changes.attrChanges.length, "project")} attributes`);
  }
  if (changes.added.length > 0) {
    parts.push(`add ${changes.added.length} ${pluralize(changes.added.length, "project")}`);
  }
  if (changes.removed.length > 0) {
    parts.push(`remove ${changes.removed.length} ${pluralize(changes.removed.length, "project")}`);
  }

  return parts.length > 0 ? `board: ${parts.slice(0, 3).join(", ")}` : "board: update project board";
}

function buildCommitMessage(oldBoard: Map<string, BoardEntry>, newBoard: Map<string, BoardEntry>) {
  const changes = summarizeChanges(oldBoard, newBoard);
  const total =
    changes.added.length +
    changes.removed.length +
    changes.moved.length +
    changes.reparents.length +
    changes.attrChanges.length;

  if (total === 0) {
    return null;
  }

  if (total > 1) {
    return summarizeMany(changes);
  }

  if (changes.moved.length === 1) {
    return `board: move ${changes.moved[0]?.name} to ${changes.moved[0]?.to}`;
  }

  if (changes.reparents.length === 1) {
    const change = changes.reparents[0];
    return change?.to ? `board: move ${change.name} under ${change.to}` : `board: unparent ${change?.name}`;
  }

  if (changes.attrChanges.length === 1) {
    const change = changes.attrChanges[0];
    return `board: update ${change?.parts.join(" and ")} for ${change?.name}`;
  }

  if (changes.added.length === 1) {
    return `board: add ${changes.added[0]}`;
  }

  if (changes.removed.length === 1) {
    return `board: remove ${changes.removed[0]}`;
  }

  return "board: update project board";
}

async function readCodexBoardBarSettings(vaultPath: string): Promise<CodexBoardBarSettings> {
  const dataPath = path.join(vaultPath, ".obsidian", "plugins", "codex-board-bar", "data.json");
  const workspaceRoot = path.dirname(vaultPath);
  const boardPath = path.relative(workspaceRoot, path.join(vaultPath, BOARD_PATH));

  try {
    const raw = await readFile(dataPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CodexBoardBarSettings>;
    return {
      ...DEFAULT_CODEX_SETTINGS,
      workspaceRoot,
      boardPath,
      ...parsed
    };
  } catch {
    return {
      ...DEFAULT_CODEX_SETTINGS,
      workspaceRoot,
      boardPath
    };
  }
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function localIso(date = new Date()) {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function localDay(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function normalizeFocusItem(input: unknown, fallbackDuration: number): FocusQueueItem {
  const payload = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const project = String(payload.project ?? "").trim();
  const note = String(payload.note ?? "").trim();
  const durationMinutes = Math.max(
    1,
    Number.parseInt(String(payload.durationMinutes ?? fallbackDuration), 10) || fallbackDuration
  );
  if (!project) {
    throw new Error("Project is required.");
  }
  return { project, note, durationMinutes };
}

function focusDataPath(vaultPath: string) {
  return path.join(vaultPath, ".obsidian", "plugins", "project-focus-timer", "data.json");
}

async function readFocusTimerState(vaultPath: string): Promise<FocusTimerState> {
  const defaults: FocusTimerState = {
    durationMinutes: 20,
    logPath: FOCUS_LOG_PATH,
    queue: [],
    current: null
  };

  try {
    const raw = await readFile(focusDataPath(vaultPath), "utf8");
    const parsed = JSON.parse(raw) as Partial<FocusTimerState>;
    return {
      ...defaults,
      ...parsed,
      queue: Array.isArray(parsed.queue) ? parsed.queue : [],
      current: parsed.current?.startedAt ? parsed.current : null
    };
  } catch {
    return defaults;
  }
}

async function writeFocusTimerState(vaultPath: string, state: FocusTimerState) {
  const dataPath = focusDataPath(vaultPath);
  await mkdir(path.dirname(dataPath), { recursive: true });
  await writeFile(dataPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function focusEntryLine(entry: Record<string, unknown>) {
  const type = String(entry.type ?? "started");
  const label = type === "completed" ? "completed" : type === "abandoned" ? "abandoned" : "started";
  const project = String(entry.project ?? "");
  const note = String(entry.note ?? "");
  const duration = Number(entry.duration_minutes ?? 20);
  const queue = Array.isArray(entry.queue) && entry.queue.length
    ? `; queued: ${entry.queue.map((item) => String((item as FocusQueueItem).project ?? "")).filter(Boolean).join(", ")}`
    : "";
  const suffix = note ? ` - ${note}` : "";
  return `- ${String(entry.started_at ?? entry.timestamp)} - ${label} ${duration}m on [[${project}]]${suffix}${queue}\n  <!-- focus-session ${JSON.stringify(entry)} -->\n`;
}

async function appendFocusLog(vaultPath: string, logPath: string, entry: Record<string, unknown>) {
  const absoluteLogPath = path.join(vaultPath, logPath || FOCUS_LOG_PATH);
  const day = localDay(new Date(String(entry.timestamp ?? Date.now())));
  let text = "# Focus Time Log\n\n";
  try {
    text = await readFile(absoluteLogPath, "utf8");
  } catch {
    await mkdir(path.dirname(absoluteLogPath), { recursive: true });
  }

  if (!text.includes(`## ${day}`)) {
    text = `${text.trimEnd()}\n\n## ${day}\n`;
  }

  await writeFile(absoluteLogPath, `${text.trimEnd()}\n${focusEntryLine(entry)}`, "utf8");
}

async function startFocusSession(vaultPath: string, state: FocusTimerState, item: FocusQueueItem) {
  if (state.current) {
    throw new Error("A focus block is already running.");
  }
  const started = new Date();
  const ends = new Date(started.getTime() + item.durationMinutes * 60 * 1000);
  state.durationMinutes = item.durationMinutes;
  state.current = {
    project: item.project,
    note: item.note,
    durationMinutes: item.durationMinutes,
    startedAt: localIso(started),
    endsAt: localIso(ends)
  };
  await appendFocusLog(vaultPath, state.logPath, {
    type: "started",
    timestamp: localIso(started),
    started_at: localIso(started),
    ends_at: localIso(ends),
    project: item.project,
    note: item.note,
    duration_minutes: item.durationMinutes,
    queue: state.queue.slice(0, 8)
  });
}

async function recordFocusSession(vaultPath: string, state: FocusTimerState, item: FocusQueueItem) {
  const finished = new Date();
  const started = new Date(finished.getTime() - item.durationMinutes * 60 * 1000);
  state.durationMinutes = item.durationMinutes;
  await appendFocusLog(vaultPath, state.logPath, {
    type: "completed",
    timestamp: localIso(finished),
    started_at: localIso(started),
    ended_at: localIso(finished),
    project: item.project,
    note: item.note,
    duration_minutes: item.durationMinutes,
    actual_minutes: item.durationMinutes,
    recorded: true,
    queue: state.queue.slice(0, 8)
  });
}

async function finishFocusSession(vaultPath: string, state: FocusTimerState, type: "completed" | "abandoned") {
  if (!state.current) {
    return;
  }
  const finished = new Date();
  const startedMs = new Date(state.current.startedAt).getTime();
  await appendFocusLog(vaultPath, state.logPath, {
    type,
    timestamp: localIso(finished),
    started_at: state.current.startedAt,
    ended_at: localIso(finished),
    project: state.current.project,
    note: state.current.note,
    duration_minutes: state.current.durationMinutes,
    actual_minutes: Math.max(1, Math.round((finished.getTime() - startedMs) / 60000)),
    queue: state.queue.slice(0, 8)
  });
  state.current = null;
}

function buildPrompt(userPrompt: string, boardPath: string, maxEdits: number, extraInstructions: string) {
  const lines = [
    `Edit only ${boardPath}.`,
    `Make at most ${maxEdits} discrete board edits.`,
    "Do not touch any other files.",
    "Prefer moving, reclassifying, reprioritizing, pruning, or retagging board cards.",
    "If a request would need more than the edit budget, do the highest-value subset and stop."
  ];

  if (extraInstructions.trim()) {
    lines.push(extraInstructions.trim());
  }

  lines.push("", `Task: ${userPrompt.trim()}`);
  return lines.join("\n");
}

async function autoCommitBoard(repoPath: string, boardPath: string) {
  const boardFilePath = path.join(repoPath, boardPath);
  const current = await readFile(boardFilePath, "utf8");
  const diffBefore = await execFileAsync("git", ["diff", "--", boardPath], repoPath);

  if (!diffBefore.stdout.trim()) {
    return null;
  }

  let previous = "";
  try {
    const result = await execFileAsync("git", ["show", `HEAD:${boardPath}`], repoPath);
    previous = result.stdout ?? "";
  } catch {
    previous = "";
  }

  const message = buildCommitMessage(parseBoard(previous), parseBoard(current)) ?? "board: update project board";
  await execFileAsync("git", ["add", "--", boardPath], repoPath);
  const staged = await execFileAsync("git", ["diff", "--cached", "--name-only", "--", boardPath], repoPath);

  if (!staged.stdout.trim()) {
    return null;
  }

  await execFileAsync("git", ["commit", "-m", message, "--", boardPath], repoPath);
  return message;
}

function scheduleBoardCommit(repoPath: string, boardPath: string) {
  const key = `${repoPath}:${boardPath}`;
  const pending = pendingBoardCommitTimers.get(key);
  if (pending) {
    clearTimeout(pending);
  }

  pendingBoardCommitTimers.set(
    key,
    setTimeout(async () => {
      pendingBoardCommitTimers.delete(key);
      try {
        await autoCommitBoard(repoPath, boardPath);
      } catch (error) {
        console.error("board-autocommit adapter failed", error);
      }
    }, BOARD_AUTOCOMMIT_DEBOUNCE_MS)
  );
}

const adapters: BrowserExtensionAdapter[] = [
  {
    pluginId: "board-autocommit",
    async getContribution(context) {
      if (!context.enabledPlugins.has("board-autocommit")) {
        return null;
      }

      return {
        pluginId: "board-autocommit",
        name: "Board Auto Commit",
        kind: "automation",
        placement: "background",
        enabled: true,
        description: "Debounced git commits after board edits.",
        config: {
          debounceMs: BOARD_AUTOCOMMIT_DEBOUNCE_MS
        }
      };
    },
    async onNoteSaved(context, notePath) {
      if (!context.enabledPlugins.has("board-autocommit") || notePath !== BOARD_PATH) {
        return [];
      }

      scheduleBoardCommit(context.repoPath, notePath);
      return [`Auto-commit scheduled for ${BOARD_AUTOCOMMIT_DEBOUNCE_MS / 1000}s after the last board edit.`];
    }
  },
  {
    pluginId: "project-focus-timer",
    async getContribution(context) {
      if (!context.enabledPlugins.has("project-focus-timer")) {
        return null;
      }

      const state = await readFocusTimerState(context.vaultPath);
      return {
        pluginId: "project-focus-timer",
        name: "Project Focus Timer",
        kind: "focus-timer",
        placement: "board-toolbar",
        enabled: true,
        description: "Project-backed focus timer with queued blocks and Markdown time logs.",
        config: {
          durationMinutes: state.durationMinutes,
          logPath: state.logPath,
          queueLength: state.queue.length,
          hasCurrent: Boolean(state.current)
        }
      };
    },
    async invokeAction(context, action) {
      if (!context.enabledPlugins.has("project-focus-timer")) {
        return { ok: false, message: "Project Focus Timer is not enabled in this vault." };
      }

      const state = await readFocusTimerState(context.vaultPath);
      try {
        if (action.actionId === "status") {
          return { ok: true, message: "Project Focus Timer status.", data: state };
        }

        if (action.actionId === "start") {
          await startFocusSession(context.vaultPath, state, normalizeFocusItem(action.payload, state.durationMinutes));
          await writeFocusTimerState(context.vaultPath, state);
          return { ok: true, message: `Started ${state.current?.durationMinutes ?? state.durationMinutes}m on ${state.current?.project}.`, data: state };
        }

        if (action.actionId === "queue") {
          state.queue.push(normalizeFocusItem(action.payload, state.durationMinutes));
          await writeFocusTimerState(context.vaultPath, state);
          return { ok: true, message: "Focus block queued.", data: state };
        }

        if (action.actionId === "record") {
          const item = normalizeFocusItem(action.payload, state.durationMinutes);
          await recordFocusSession(context.vaultPath, state, item);
          await writeFocusTimerState(context.vaultPath, state);
          return { ok: true, message: `Recorded ${item.durationMinutes}m on ${item.project}.`, data: state };
        }

        if (action.actionId === "startQueued") {
          if (state.current) {
            throw new Error("A focus block is already running.");
          }
          const index = Math.max(0, Number.parseInt(String(action.payload?.index ?? 0), 10) || 0);
          const [item] = state.queue.splice(index, 1);
          if (!item) {
            throw new Error("Queued focus block not found.");
          }
          await startFocusSession(context.vaultPath, state, item);
          await writeFocusTimerState(context.vaultPath, state);
          return { ok: true, message: `Started queued block on ${item.project}.`, data: state };
        }

        if (action.actionId === "removeQueued") {
          const index = Number.parseInt(String(action.payload?.index ?? -1), 10);
          if (index < 0 || index >= state.queue.length) {
            throw new Error("Queued focus block not found.");
          }
          state.queue.splice(index, 1);
          await writeFocusTimerState(context.vaultPath, state);
          return { ok: true, message: "Queued focus block removed.", data: state };
        }

        if (action.actionId === "finish" || action.actionId === "abandon") {
          await finishFocusSession(context.vaultPath, state, action.actionId === "finish" ? "completed" : "abandoned");
          await writeFocusTimerState(context.vaultPath, state);
          return { ok: true, message: action.actionId === "finish" ? "Focus block completed." : "Focus block abandoned.", data: state };
        }

        return { ok: false, message: `Unsupported action: ${action.actionId}` };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Project Focus Timer action failed."
        };
      }
    }
  },
  {
    pluginId: "codex-board-bar",
    async getContribution(context) {
      if (!context.enabledPlugins.has("codex-board-bar")) {
        return null;
      }

      const settings = await readCodexBoardBarSettings(context.vaultPath);

      return {
        pluginId: "codex-board-bar",
        name: "Codex Board Bar",
        kind: "command-bar",
        placement: "board-toolbar",
        enabled: true,
        description: "Send constrained board-edit prompts to a local Codex session.",
        config: {
          defaultMaxEdits: settings.defaultMaxEdits,
          workspaceRoot: settings.workspaceRoot,
          boardPath: settings.boardPath
        }
      };
    },
    async invokeAction(context, action) {
      if (!context.enabledPlugins.has("codex-board-bar")) {
        return {
          ok: false,
          message: "Codex Board Bar is not enabled in this vault."
        };
      }

      if (action.actionId !== "run") {
        return {
          ok: false,
          message: `Unsupported action: ${action.actionId}`
        };
      }

      const prompt = String(action.payload?.prompt ?? "").trim();
      const settings = await readCodexBoardBarSettings(context.vaultPath);
      const maxEdits = Math.max(
        1,
        Number.parseInt(String(action.payload?.maxEdits ?? settings.defaultMaxEdits), 10) || settings.defaultMaxEdits
      );

      if (!prompt) {
        return {
          ok: false,
          message: "Prompt is required."
        };
      }

      const finalPrompt = buildPrompt(prompt, settings.boardPath, maxEdits, settings.extraInstructions);

      try {
        const result = await execFileAsync(
          settings.codexPath,
          [
            "exec",
            "-C",
            settings.workspaceRoot,
            "-c",
            'approval_policy="never"',
            "--sandbox",
            "workspace-write",
            "--add-dir",
            settings.workspaceRoot,
            finalPrompt
          ],
          settings.workspaceRoot
        );

        return {
          ok: true,
          message: "Codex board edit finished.",
          output: `${result.stdout}${result.stderr}`.trim()
        };
      } catch (error) {
        const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "") : "";
        const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "") : "";

        return {
          ok: false,
          message: "Codex board edit failed.",
          output: `${stdout}${stderr}`.trim()
        };
      }
    }
  }
];

function createContext(vaultPath: string, pluginManifests: PluginManifestSummary[]): BrowserExtensionAdapterContext {
  return {
    vaultPath,
    repoPath: vaultPath,
    enabledPlugins: new Set(pluginManifests.filter((manifest) => manifest.enabled).map((manifest) => manifest.id)),
    pluginManifests
  };
}

export async function getExtensionContributions(
  vaultPath: string,
  pluginManifests: PluginManifestSummary[]
): Promise<ExtensionContribution[]> {
  const context = createContext(vaultPath, pluginManifests);
  const contributions = await Promise.all(adapters.map((adapter) => adapter.getContribution?.(context) ?? null));
  return contributions.filter((contribution): contribution is ExtensionContribution => contribution !== null);
}

export async function notifyNoteSaved(
  vaultPath: string,
  pluginManifests: PluginManifestSummary[],
  notePath: string
): Promise<string[]> {
  const context = createContext(vaultPath, pluginManifests);
  const notices = await Promise.all(adapters.map((adapter) => adapter.onNoteSaved?.(context, notePath) ?? []));
  return notices.flat();
}

export async function runExtensionAction(
  vaultPath: string,
  pluginManifests: PluginManifestSummary[],
  action: ExtensionActionRequest
): Promise<ExtensionActionResponse> {
  const adapter = adapters.find((candidate) => candidate.pluginId === action.pluginId);
  if (!adapter?.invokeAction) {
    return {
      ok: false,
      message: `No browser adapter registered for ${action.pluginId}.`
    };
  }

  return adapter.invokeAction(createContext(vaultPath, pluginManifests), action);
}
