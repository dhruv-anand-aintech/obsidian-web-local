import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, LoaderCircle, XCircle } from "lucide-react";
import type {
  ExtensionActionResponse,
  NoteDetail,
  PluginHostStatus,
  UpdateNoteResponse,
  VaultDetail,
  VaultSummary
} from "@obsidian-web-local/shared";
import { noteRenderers } from "./features/renderers";

type LoadState = "idle" | "loading" | "ready" | "error";
type SyncState = "synced" | "saving" | "error";

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export function App() {
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);
  const [selectedVault, setSelectedVault] = useState<VaultDetail | null>(null);
  const [selectedNotePath, setSelectedNotePath] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<NoteDetail | null>(null);
  const [pluginHost, setPluginHost] = useState<PluginHostStatus | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncState>("synced");
  const [isLeftPaneCollapsed, setIsLeftPaneCollapsed] = useState(true);
  const [isRightPaneCollapsed, setIsRightPaneCollapsed] = useState(true);

  useEffect(() => {
    let isActive = true;

    async function loadShell() {
      setLoadState("loading");
      setError(null);

      try {
        const [vaultPayload, pluginHostPayload] = await Promise.all([
          fetchJson<{ vaults: VaultSummary[] }>("/api/vaults"),
          fetchJson<PluginHostStatus>("/api/plugin-host")
        ]);

        if (!isActive) {
          return;
        }

        setVaults(vaultPayload.vaults);
        setPluginHost(pluginHostPayload);
        setSelectedVaultId((current) => {
          if (current) {
            return current;
          }

          return vaultPayload.vaults[0]?.id ?? null;
        });
        setLoadState("ready");
      } catch (loadError) {
        if (!isActive) {
          return;
        }

        setLoadState("error");
        setError(loadError instanceof Error ? loadError.message : "Unknown error");
      }
    }

    void loadShell();

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedVaultId) {
      setSelectedVault(null);
      return;
    }

    let isActive = true;

    async function loadVaultDetail() {
      try {
        const payload = await fetchJson<VaultDetail>(`/api/vaults/${selectedVaultId}`);
        if (!isActive) {
          return;
        }

        setSelectedVault(payload);
        setSelectedNotePath((current) => {
          if (current && payload.notes.some((note) => note.path === current)) {
            return current;
          }

          return (
            payload.notes.find((note) => note.path === "PROJECTS-KANBAN.md")?.path ??
            payload.notes.find((note) => note.viewTypes.includes("kanban"))?.path ??
            payload.notes[0]?.path ??
            null
          );
        });
      } catch (loadError) {
        if (isActive) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load vault");
        }
      }
    }

    void loadVaultDetail();

    return () => {
      isActive = false;
    };
  }, [selectedVaultId]);

  useEffect(() => {
    if (!selectedVaultId || !selectedNotePath) {
      setSelectedNote(null);
      return;
    }

    setSyncState("synced");

    const activeVaultId = selectedVaultId;
    const activeNotePath = selectedNotePath;
    let isActive = true;

    async function loadNoteDetail() {
      try {
        const payload = await fetchJson<NoteDetail>(
          `/api/vaults/${activeVaultId}/note?path=${encodeURIComponent(activeNotePath)}`
        );

        if (isActive) {
          setSelectedNote(payload);
        }
      } catch (loadError) {
        if (isActive) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load note");
        }
      }
    }

    void loadNoteDetail();

    return () => {
      isActive = false;
    };
  }, [selectedNotePath, selectedVaultId]);

  const selectedVaultMeta = useMemo(
    () => vaults.find((vault) => vault.id === selectedVaultId) ?? null,
    [selectedVaultId, vaults]
  );

  const activeRenderer = useMemo(
    () => (selectedNote ? noteRenderers.find((renderer) => renderer.supports(selectedNote)) : null) ?? null,
    [selectedNote]
  );

  async function persistNote(notePath: string, content: string): Promise<NoteDetail> {
    if (!selectedVaultId) {
      throw new Error("No vault selected");
    }

    setSyncState("saving");

    try {
      const response = await fetch(`/api/vaults/${selectedVaultId}/note`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ path: notePath, content })
      });

      if (!response.ok) {
        throw new Error(`Failed to persist note: ${response.status}`);
      }

      const payload = (await response.json()) as UpdateNoteResponse;
      setSelectedNote(payload.note);
      setSyncState("synced");
      return payload.note;
    } catch (persistError) {
      setSyncState("error");
      throw persistError;
    }
  }

  async function openResource(target: string, kind: "url" | "path"): Promise<void> {
    const response = await fetch("/api/open-resource", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ target, kind })
    });

    if (!response.ok) {
      throw new Error(`Failed to open resource: ${response.status}`);
    }
  }

  async function runExtensionAction(payload: {
    pluginId: string;
    actionId: string;
    payload?: Record<string, unknown>;
  }): Promise<ExtensionActionResponse> {
    if (!selectedVaultId) {
      throw new Error("No vault selected");
    }

    const response = await fetch(`/api/vaults/${selectedVaultId}/extension-action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Failed to run extension action: ${response.status}`);
    }

    return (await response.json()) as ExtensionActionResponse;
  }

  const shellClassName = [
    "shell",
    isLeftPaneCollapsed ? "shell--left-collapsed" : "",
    isRightPaneCollapsed ? "shell--right-collapsed" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClassName}>
      <aside className="rail" aria-label="Vault and note navigation" aria-hidden={isLeftPaneCollapsed}>
        <button
          aria-label="Collapse left pane"
          className="pane-toggle pane-toggle--left"
          onClick={() => setIsLeftPaneCollapsed(true)}
          title="Collapse left pane"
          type="button"
        >
          ‹
        </button>
        <div className="rail__header">
          <p className="eyebrow">Local-first</p>
          <h1>Obsidian Web Local</h1>
          <p className="muted">
            Browser UI with a constrained helper process for vault access and generalized note renderers.
          </p>
        </div>

        <section className="panel">
          <div className="panel__header">
            <h2>Vaults</h2>
            <span className="badge">{vaults.length}</span>
          </div>

          {loadState === "loading" && <p className="muted">Loading local vault index…</p>}
          {loadState === "error" && <p className="error">{error ?? "Failed to load"}</p>}

          <div className="vault-list">
            {vaults.map((vault) => {
              const isSelected = vault.id === selectedVaultId;
              return (
                <button
                  key={vault.id}
                  className={`vault-card${isSelected ? " vault-card--selected" : ""}`}
                  onClick={() => setSelectedVaultId(vault.id)}
                  type="button"
                >
                  <span className="vault-card__title">{vault.name}</span>
                  <span className="vault-card__meta">{vault.noteCount} notes</span>
                  <span className="vault-card__meta">{vault.pluginCount} plugins</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="panel">
          <div className="panel__header">
            <h2>Notes</h2>
            <span className="badge">{selectedVault?.notes.length ?? 0}</span>
          </div>

          <div className="note-list">
            {(selectedVault?.notes ?? []).map((note) => {
              const isSelected = note.path === selectedNotePath;

              return (
                <button
                  key={note.path}
                  className={`note-row note-row--button${isSelected ? " note-row--selected" : ""}`}
                  onClick={() => setSelectedNotePath(note.path)}
                  type="button"
                >
                  <div className="note-row__text">
                    <strong>{note.title}</strong>
                    <span>{note.path}</span>
                  </div>
                  <div className="note-row__views">
                    {note.viewTypes.map((viewType) => (
                      <span className="badge badge--compact" key={`${note.path}-${viewType}`}>
                        {viewType}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      </aside>

      {isLeftPaneCollapsed && (
        <button
          aria-label="Expand left pane"
          className="pane-toggle pane-toggle--floating pane-toggle--floating-left"
          onClick={() => setIsLeftPaneCollapsed(false)}
          title="Expand left pane"
          type="button"
        >
          ›
        </button>
      )}

      <main className="workspace">
        <section className="hero">
          <div>
            <p className="eyebrow">Selected vault</p>
            <h2>{selectedVaultMeta?.name ?? "No vault selected"}</h2>
            <p className="muted">{selectedVaultMeta?.path ?? "Waiting for helper data"}</p>
          </div>
          <div className="hero__stats">
            <div className="stat">
              <span className="stat__label">Notes</span>
              <strong>{selectedVaultMeta?.noteCount ?? 0}</strong>
            </div>
            <div className="stat">
              <span className="stat__label">Plugins</span>
              <strong>{selectedVaultMeta?.pluginCount ?? 0}</strong>
            </div>
          </div>
        </section>

        <div className="workspace__grid">
          <section className="panel panel--content">
            <div className="panel__header">
              <h2>{selectedNote?.title ?? "Note viewer"}</h2>
              <div className="panel__header-actions">
                {activeRenderer && <span className="badge">{activeRenderer.label}</span>}
                {selectedNote && <span className="badge">{new Date(selectedNote.updatedAt).toLocaleString()}</span>}
                {selectedNote && (
                  <span className={`sync-pill sync-pill--${syncState}`}>
                    {syncState === "saving" ? <LoaderCircle size={14} className="spin" /> : null}
                    {syncState === "synced" ? <CheckCircle2 size={14} /> : null}
                    {syncState === "error" ? <XCircle size={14} /> : null}
                    <span>{syncState === "saving" ? "Saving" : syncState === "synced" ? "Synced" : "Sync failed"}</span>
                  </span>
                )}
              </div>
            </div>

            {selectedNote && activeRenderer ? (
              activeRenderer.render(selectedNote, {
                extensions: selectedVault?.extensionContributions ?? [],
                projectNames: selectedVault?.projectNames ?? {},
                repoVisibilities: selectedVault?.repoVisibilities ?? {},
                onPersist: persistNote,
                onOpenResource: openResource,
                onRunExtensionAction: runExtensionAction
              })
            ) : (
              <p className="muted">Choose a note to inspect it.</p>
            )}
          </section>

          <section className="panel inspector-panel" aria-label="Plugin host and extension details" aria-hidden={isRightPaneCollapsed}>
            <div className="panel__header">
              <h2>Plugin host</h2>
              <div className="panel__header-actions">
                <span className="badge">{pluginHost?.capabilities.length ?? 0}</span>
                <button
                  aria-label="Collapse right pane"
                  className="pane-toggle pane-toggle--right"
                  onClick={() => setIsRightPaneCollapsed(true)}
                  title="Collapse right pane"
                  type="button"
                >
                  ›
                </button>
              </div>
            </div>

            {pluginHost && (
              <>
                <p className="muted">{pluginHost.summary}</p>
                <div className="capability-list">
                  {pluginHost.capabilities.map((capability) => (
                    <div className="capability-row" key={capability.key}>
                      <div>
                        <strong>{capability.key}</strong>
                        <p>{capability.notes}</p>
                      </div>
                      <span className="capability-source">{capability.providedBy}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="plugin-list">
              {(selectedVault?.pluginManifests ?? []).map((plugin) => (
                <div className="plugin-row" key={plugin.id}>
                  <div>
                    <strong>{plugin.name}</strong>
                    <p>{plugin.description || plugin.id}</p>
                    <p className="plugin-reasons">{plugin.compatibilityReasons.join(" · ")}</p>
                  </div>
                  <div className="plugin-row__meta">
                    <span className={`plugin-status plugin-status--${plugin.compatibility}`}>
                      {plugin.compatibility}
                    </span>
                    <span className={`plugin-status plugin-status--${plugin.enabled ? "enabled" : "disabled"}`}>
                      {plugin.enabled ? "enabled" : "disabled"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>

      {isRightPaneCollapsed && (
        <button
          aria-label="Expand right pane"
          className="pane-toggle pane-toggle--floating pane-toggle--floating-right"
          onClick={() => setIsRightPaneCollapsed(false)}
          title="Expand right pane"
          type="button"
        >
          ‹
        </button>
      )}
    </div>
  );
}
