export interface VaultSummary {
  id: string;
  name: string;
  path: string;
  noteCount: number;
  pluginCount: number;
}

export interface NoteSummary {
  path: string;
  title: string;
  viewTypes: string[];
}

export interface NoteDetail extends NoteSummary {
  content: string;
  updatedAt: string;
}

export interface UpdateNoteRequest {
  path: string;
  content: string;
}

export interface UpdateNoteResponse {
  note: NoteDetail;
  notices: string[];
}

export type PluginCompatibility = "native" | "shimmed" | "unsupported";

export interface PluginManifestSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  compatibility: PluginCompatibility;
  compatibilityReasons: string[];
}

export interface ExtensionContribution {
  pluginId: string;
  name: string;
  kind: "command-bar" | "automation" | "focus-timer";
  placement: "board-toolbar" | "background";
  enabled: boolean;
  description?: string;
  config?: Record<string, string | number | boolean>;
}

export interface VaultDetail {
  id: string;
  name: string;
  path: string;
  projectNames: Record<string, string>;
  notes: NoteSummary[];
  pluginManifests: PluginManifestSummary[];
  extensionContributions: ExtensionContribution[];
}

export interface CompatibilityCapability {
  key: string;
  providedBy: "browser" | "helper" | "bridge";
  notes: string;
}

export interface PluginHostStatus {
  summary: string;
  capabilities: CompatibilityCapability[];
}

export interface ExtensionActionRequest {
  pluginId: string;
  actionId: string;
  payload?: Record<string, unknown>;
}

export interface ExtensionActionResponse {
  ok: boolean;
  message: string;
  output?: string;
  data?: unknown;
}

export interface OpenResourceRequest {
  target: string;
  kind: "url" | "path";
}
