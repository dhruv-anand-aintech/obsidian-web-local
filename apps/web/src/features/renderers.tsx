import type { JSX } from "react";
import type { ExtensionActionResponse, ExtensionContribution, NoteDetail } from "@obsidian-web-local/shared";
import { KanbanBoard } from "./kanban";

export type NoteRendererContext = {
  extensions: ExtensionContribution[];
  onPersist: (notePath: string, content: string) => Promise<NoteDetail>;
  onOpenResource: (target: string, kind: "url" | "path") => Promise<void>;
  onRunExtensionAction: (payload: {
    pluginId: string;
    actionId: string;
    payload?: Record<string, unknown>;
  }) => Promise<ExtensionActionResponse>;
};

export type NoteRenderer = {
  id: string;
  label: string;
  supports: (note: NoteDetail) => boolean;
  render: (note: NoteDetail, context: NoteRendererContext) => JSX.Element;
};

function MarkdownNote({ note }: { note: NoteDetail }) {
  return (
    <section className="markdown-note">
      <div className="kanban-board__header">
        <div>
          <p className="eyebrow">Renderer</p>
          <h3>Markdown</h3>
        </div>
        <span className="badge">{note.viewTypes.join(", ")}</span>
      </div>
      <pre className="markdown-note__content">{note.content}</pre>
    </section>
  );
}

export const noteRenderers: NoteRenderer[] = [
  {
    id: "kanban",
    label: "Kanban",
    supports: (note) => note.viewTypes.includes("kanban"),
    render: (note, context) => <KanbanBoard note={note} {...context} />
  },
  {
    id: "markdown",
    label: "Markdown",
    supports: () => true,
    render: (note) => <MarkdownNote note={note} />
  }
];
