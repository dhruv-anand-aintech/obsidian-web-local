import type { CompatibilityCapability, PluginHostStatus, PluginManifestSummary } from "@obsidian-web-local/shared";

const capabilities: CompatibilityCapability[] = [
  {
    key: "workspace-events",
    providedBy: "browser",
    notes: "Browser runtime can own pane state, commands, and view events."
  },
  {
    key: "vault-io",
    providedBy: "helper",
    notes: "Filesystem reads and writes stay inside the local helper."
  },
  {
    key: "metadata-cache",
    providedBy: "bridge",
    notes: "Cache reads should be projected through typed helper endpoints."
  },
  {
    key: "plugin-sandbox",
    providedBy: "bridge",
    notes: "Future plugin execution must happen behind explicit capability grants."
  }
];

export function buildPluginHostStatus(): PluginHostStatus {
  return {
    summary:
      "The scaffold exposes vault metadata today and reserves plugin execution for a later sandboxed host.",
    capabilities
  };
}

interface PluginClassifierInput {
  id: string;
  name: string;
  description?: string;
  mainEntryExists: boolean;
  mainEntrySource?: string;
}

interface PluginClassifierResult {
  compatibility: PluginManifestSummary["compatibility"];
  compatibilityReasons: string[];
}

const unsupportedSignatures: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(node:)?child_process\b|\bexec(?:sync)?\b|\bspawn(?:sync)?\b/i, reason: "uses child processes" },
  { pattern: /\b(node:)?fs\b|\b(node:)?path\b|\b(node:)?os\b|\bwindow\.require\b/i, reason: "uses node filesystem APIs directly" },
  { pattern: /\belectron\b|\bipcRenderer\b|\bshell\.openPath\b|\bshell\.openExternal\b/i, reason: "depends on Electron desktop APIs" },
  { pattern: /\bnet\b|\bdgram\b|\bserialport\b/i, reason: "depends on local machine integration APIs" }
];

const nativeSignatures: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bregisterMarkdown(PostProcessor|CodeBlockProcessor)\b/i, reason: "extends markdown rendering" },
  { pattern: /\baddCommand\b|\baddRibbonIcon\b|\baddStatusBarItem\b/i, reason: "adds workspace commands or chrome" },
  { pattern: /\bregisterView\b|\bsetViewState\b|\bworkspace\b/i, reason: "uses workspace view APIs" },
  { pattern: /\bmetadataCache\b|\bfrontmatter\b|\bgetFileCache\b/i, reason: "reads metadata cache" }
];

export function classifyPluginManifest(input: PluginClassifierInput): PluginClassifierResult {
  const signature = `${input.id} ${input.name} ${input.description ?? ""}`.toLowerCase();
  const source = input.mainEntrySource ?? "";
  const reasons: string[] = [];

  if (!input.mainEntryExists) {
    return {
      compatibility: "unsupported",
      compatibilityReasons: ["missing main.js entrypoint"]
    };
  }

  for (const rule of unsupportedSignatures) {
    if (rule.pattern.test(source)) {
      reasons.push(rule.reason);
    }
  }

  if (reasons.length > 0) {
    return {
      compatibility: "unsupported",
      compatibilityReasons: [...new Set(reasons)]
    };
  }

  for (const rule of nativeSignatures) {
    if (rule.pattern.test(source)) {
      reasons.push(rule.reason);
    }
  }

  if (reasons.length > 0) {
    return {
      compatibility: "native",
      compatibilityReasons: [...new Set(reasons)]
    };
  }

  if (/\b(sync|git|terminal|shell|filesystem|desktop)\b/i.test(signature)) {
    return {
      compatibility: "unsupported",
      compatibilityReasons: ["manifest description suggests desktop-only behavior"]
    };
  }

  return {
    compatibility: "shimmed",
    compatibilityReasons: ["no unsupported desktop APIs detected; would run behind the browser helper bridge"]
  };
}
