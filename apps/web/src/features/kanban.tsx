import { useEffect, useMemo, useState } from "react";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FolderOpen, GitBranch, GripVertical, LoaderCircle, Sparkles } from "lucide-react";
import { parse as parseYaml } from "yaml";
import type { ExtensionActionResponse, ExtensionContribution, NoteDetail } from "@obsidian-web-local/shared";

type AttributeDefinition = {
  key: string;
  label: string;
  shortLabel?: string;
  type?: string;
  options?: string[];
};

type KanbanAttribute = {
  key: string;
  value: string;
};

type KanbanChild = {
  id: string;
  linkTarget: string;
  title: string;
  rawText: string;
};

type ResourceTarget =
  | { kind: "url"; target: string; isGithub: boolean }
  | { kind: "path"; target: string; isGithub: false }
  | null;

type KanbanCard = {
  id: string;
  linkTarget: string;
  title: string;
  checked: boolean;
  tags: string[];
  attributes: KanbanAttribute[];
  children: KanbanChild[];
  resource: ResourceTarget;
};

type KanbanLane = {
  id: string;
  title: string;
  cards: KanbanCard[];
};

type KanbanBoardModel = {
  frontmatter: string | null;
  footer: string | null;
  attributeDefinitions: Record<string, AttributeDefinition>;
  lanes: KanbanLane[];
};

type CardLocation = {
  laneId: string;
  index: number;
};

type ActiveLaneSort = {
  attributeKey: string;
  direction: "asc" | "desc";
};

type KanbanBoardProps = {
  note: NoteDetail;
  extensions: ExtensionContribution[];
  onPersist: (notePath: string, content: string) => Promise<NoteDetail>;
  onOpenResource: (target: string, kind: "url" | "path") => Promise<void>;
  onRunExtensionAction: (payload: {
    pluginId: string;
    actionId: string;
    payload?: Record<string, unknown>;
  }) => Promise<ExtensionActionResponse>;
};

const INLINE_ATTRIBUTE_RE = /\[([A-Za-z][A-Za-z0-9_-]*):([^\]]*)\]/g;
const TAG_RE = /(^|\s)#([^\s#]+)/g;
const WIKI_LINK_RE = /\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/;

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function splitNote(content: string) {
  const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n?/);
  const frontmatter = frontmatterMatch ? frontmatterMatch[0].trimEnd() : null;
  const withoutFrontmatter = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;
  const footerMatch = withoutFrontmatter.match(/\n%%\nkanban:settings[\s\S]*$/);

  return {
    frontmatter,
    body: footerMatch ? withoutFrontmatter.slice(0, footerMatch.index ?? withoutFrontmatter.length).trimEnd() : withoutFrontmatter.trimEnd(),
    footer: footerMatch ? footerMatch[0].trimEnd() : null
  };
}

function parseFrontmatter(frontmatter: string | null): Record<string, unknown> {
  if (!frontmatter) {
    return {};
  }

  const raw = frontmatter.replace(/^---\n?/, "").replace(/\n?---$/, "");
  try {
    return (parseYaml(raw) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

function stripPresentationTokens(raw: string) {
  return raw
    .replace(INLINE_ATTRIBUTE_RE, "")
    .replace(TAG_RE, " ")
    .trim();
}

function parseLink(text: string) {
  const match = text.match(WIKI_LINK_RE);
  if (!match) {
    const stripped = stripPresentationTokens(text);
    return {
      linkTarget: stripped,
      title: stripped
    };
  }

  return {
    linkTarget: match[1] ?? "",
    title: match[2] ?? match[1] ?? ""
  };
}

function parseCard(raw: string, laneTitle: string, index: number, childLines: string[]): KanbanCard {
  const checked = /^\[[xX]\]/.test(raw);
  const content = raw.replace(/^\[[xX ]\]\s*/, "");
  const attributes = Array.from(content.matchAll(INLINE_ATTRIBUTE_RE)).map((match) => ({
    key: match[1] ?? "",
    value: (match[2] ?? "").trim()
  }));
  const tags = Array.from(content.matchAll(TAG_RE))
    .map((match) => match[2] ?? "")
    .filter(Boolean);

  const { linkTarget, title } = parseLink(content);
  const resourceAttribute = attributes.find((attribute) => ["url", "path"].includes(attribute.key.toLowerCase()));
  const resource: ResourceTarget = resourceAttribute
    ? resourceAttribute.key.toLowerCase() === "url"
      ? { kind: "url", target: resourceAttribute.value, isGithub: /github\.com/.test(resourceAttribute.value) }
      : { kind: "path", target: resourceAttribute.value, isGithub: false }
    : null;

  return {
    id: `card-${slugify(linkTarget || title || `${laneTitle}-${index}`)}`,
    linkTarget,
    title,
    checked,
    tags,
    attributes: attributes.filter((attribute) => !["url", "path"].includes(attribute.key.toLowerCase())),
    resource,
    children: childLines.map((line, childIndex) => {
      const childText = line.replace(/^\s+- child:\s*/, "");
      const childLink = parseLink(childText);

      return {
        id: `child-${slugify(childLink.linkTarget || childLink.title || `${title}-${childIndex}`)}`,
        linkTarget: childLink.linkTarget,
        title: childLink.title,
        rawText: childText
      };
    })
  };
}

export function parseKanbanNote(note: NoteDetail): KanbanBoardModel {
  const { frontmatter, body, footer } = splitNote(note.content);
  const parsedFrontmatter = parseFrontmatter(frontmatter);
  const attributeDefinitions = Object.fromEntries(
    Array.isArray(parsedFrontmatter.attributes)
      ? parsedFrontmatter.attributes
          .filter((value): value is AttributeDefinition => typeof value === "object" && value !== null && "key" in value)
          .map((definition) => [definition.key, definition])
      : []
  );

  const lines = body.split(/\r?\n/);
  const lanes: KanbanLane[] = [];
  let currentLane: KanbanLane | null = null;
  let currentCardRaw = "";
  let currentChildLines: string[] = [];

  const pushCurrentCard = () => {
    if (!currentLane || !currentCardRaw) {
      return;
    }

    currentLane.cards.push(parseCard(currentCardRaw, currentLane.title, currentLane.cards.length, currentChildLines));
    currentCardRaw = "";
    currentChildLines = [];
  };

  for (const line of lines) {
    const laneMatch = line.match(/^##\s+(.+)$/);
    if (laneMatch) {
      pushCurrentCard();
      currentLane = {
        id: `lane-${slugify((laneMatch[1] ?? "").trim())}`,
        title: (laneMatch[1] ?? "").trim(),
        cards: []
      };
      lanes.push(currentLane);
      continue;
    }

    if (!currentLane) {
      continue;
    }

    const cardMatch = line.match(/^- \[([ xX])\]\s+(.+)$/);
    if (cardMatch) {
      pushCurrentCard();
      currentCardRaw = `[${cardMatch[1] ?? " "}] ${(cardMatch[2] ?? "").trim()}`;
      continue;
    }

    if (/^\s+- child:\s+(.+)$/.test(line) && currentCardRaw) {
      currentChildLines.push(line);
    }
  }

  pushCurrentCard();

  return {
    frontmatter,
    footer,
    attributeDefinitions,
    lanes
  };
}

function serializeLink(linkTarget: string, title: string) {
  return title && title !== linkTarget ? `[[${linkTarget}|${title}]]` : `[[${linkTarget}]]`;
}

function serializeBoard(model: KanbanBoardModel) {
  const sections: string[] = [];

  if (model.frontmatter) {
    sections.push(model.frontmatter);
  }

  const laneBlocks = model.lanes.map((lane) => {
    const cardLines = lane.cards.flatMap((card) => {
      const cardLineParts = [
        `- [${card.checked ? "x" : " "}] ${serializeLink(card.linkTarget, card.title)}`,
        ...card.attributes.map((attribute) => `[${attribute.key}:${attribute.value}]`),
        ...card.tags.map((tag) => `#${tag}`)
      ];

      if (card.resource) {
        cardLineParts.push(`[${card.resource.kind}:${card.resource.target}]`);
      }

      const childLines = card.children.map((child) => `\t- child: ${serializeLink(child.linkTarget, child.title)}`);
      return [cardLineParts.join(" "), ...childLines];
    });

    return [`## ${lane.title}`, "", ...cardLines].join("\n");
  });

  sections.push(laneBlocks.join("\n\n").trim());

  if (model.footer) {
    sections.push(model.footer);
  }

  return `${sections.filter(Boolean).join("\n\n").trim()}\n`;
}

function sortStorageKey(notePath: string) {
  return `obsidian-web-local:kanban-sort:${notePath}`;
}

function readStoredLaneSorts(notePath: string): Record<string, ActiveLaneSort> {
  try {
    const raw = window.localStorage.getItem(sortStorageKey(notePath));
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, ActiveLaneSort>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, value]) =>
          value &&
          typeof value.attributeKey === "string" &&
          (value.direction === "asc" || value.direction === "desc")
      )
    );
  } catch {
    return {};
  }
}

function writeStoredLaneSorts(notePath: string, sorts: Record<string, ActiveLaneSort>) {
  try {
    window.localStorage.setItem(sortStorageKey(notePath), JSON.stringify(sorts));
  } catch {
    // localStorage can be unavailable in hardened browser contexts.
  }
}

function attributeValue(card: KanbanCard, key: string) {
  return card.attributes.find((attribute) => attribute.key === key)?.value ?? "";
}

function compareAttributeValues(left: string, right: string, definition: AttributeDefinition | undefined, direction: "asc" | "desc") {
  const dir = direction === "asc" ? 1 : -1;
  const options = definition?.options ?? [];
  const leftRank = options.indexOf(left);
  const rightRank = options.indexOf(right);

  if (leftRank !== -1 || rightRank !== -1) {
    if (leftRank === -1) {
      return 1;
    }
    if (rightRank === -1) {
      return -1;
    }
    return (leftRank - rightRank) * dir;
  }

  const leftNumber = Number(left.replace("%", ""));
  const rightNumber = Number(right.replace("%", ""));

  if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
    return (leftNumber - rightNumber) * dir;
  }

  return left.localeCompare(right) * dir;
}

function sortLaneCards(lane: KanbanLane, sort: ActiveLaneSort | undefined, definitions: Record<string, AttributeDefinition>) {
  if (!sort) {
    return lane;
  }

  const definition = definitions[sort.attributeKey];
  return {
    ...lane,
    cards: [...lane.cards].sort((left, right) =>
      compareAttributeValues(
        attributeValue(left, sort.attributeKey),
        attributeValue(right, sort.attributeKey),
        definition,
        sort.direction
      )
    )
  };
}

function applyActiveLaneSorts(board: KanbanBoardModel, sorts: Record<string, ActiveLaneSort>) {
  return {
    ...board,
    lanes: board.lanes.map((lane) => sortLaneCards(lane, sorts[lane.id], board.attributeDefinitions))
  };
}

function updateCardAttribute(board: KanbanBoardModel, cardId: string, key: string, value: string, sorts: Record<string, ActiveLaneSort>) {
  const nextBoard = {
    ...board,
    lanes: board.lanes.map((lane) => ({
      ...lane,
      cards: lane.cards.map((card) => {
        if (card.id !== cardId) {
          return card;
        }

        const hasAttribute = card.attributes.some((attribute) => attribute.key === key);
        return {
          ...card,
          attributes: hasAttribute
            ? card.attributes.map((attribute) => (attribute.key === key ? { ...attribute, value } : attribute))
            : [...card.attributes, { key, value }]
        };
      })
    }))
  };

  return applyActiveLaneSorts(nextBoard, sorts);
}

function findLane(board: KanbanBoardModel, laneId: string) {
  return board.lanes.find((lane) => lane.id === laneId) ?? null;
}

function findCardLocation(board: KanbanBoardModel, cardId: string): CardLocation | null {
  for (const lane of board.lanes) {
    const index = lane.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) {
      return { laneId: lane.id, index };
    }
  }

  return null;
}

function moveCard(board: KanbanBoardModel, activeId: string, overId: string) {
  const source = findCardLocation(board, activeId);
  if (!source) {
    return board;
  }

  const targetLane = findLane(board, overId) ?? null;
  const target = findCardLocation(board, overId);
  const destinationLaneId = targetLane?.id ?? target?.laneId;

  if (!destinationLaneId) {
    return board;
  }

  const nextLanes = board.lanes.map((lane) => ({
    ...lane,
    cards: [...lane.cards]
  }));
  const sourceLane = nextLanes.find((lane) => lane.id === source.laneId);
  const destinationLane = nextLanes.find((lane) => lane.id === destinationLaneId);

  if (!sourceLane || !destinationLane) {
    return board;
  }

  const [movedCard] = sourceLane.cards.splice(source.index, 1);
  if (!movedCard) {
    return board;
  }

  if (sourceLane.id === destinationLane.id && target) {
    destinationLane.cards.splice(target.index, 0, movedCard);
  } else if (target) {
    destinationLane.cards.splice(target.index, 0, movedCard);
  } else {
    destinationLane.cards.push(movedCard);
  }

  return { ...board, lanes: nextLanes };
}

function LaneDropZone({ laneId, children }: { laneId: string; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: laneId, data: { type: "lane-drop" } });
  return (
    <div className="kanban-lane__cards" ref={setNodeRef}>
      {children}
    </div>
  );
}

function SortableLane({
  lane,
  attributeDefinitions,
  activeSort,
  onSortChange,
  onAttributeChange,
  onOpenResource
}: {
  lane: KanbanLane;
  attributeDefinitions: Record<string, AttributeDefinition>;
  activeSort?: ActiveLaneSort;
  onSortChange: (laneId: string, sort: ActiveLaneSort | undefined) => void;
  onAttributeChange: (cardId: string, key: string, value: string) => void;
  onOpenResource: KanbanBoardProps["onOpenResource"];
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: lane.id,
    data: { type: "lane" }
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <section className={`kanban-lane${isDragging ? " is-dragging" : ""}`} ref={setNodeRef} style={style}>
      <div className="kanban-lane__header">
        <div className="kanban-lane__header-copy">
          <button className="kanban-handle" type="button" aria-label={`Drag lane ${lane.title}`} {...attributes} {...listeners}>
            <GripVertical size={14} />
          </button>
          <h4>{lane.title}</h4>
        </div>
        <div className="kanban-lane__actions">
          <select
            className="kanban-sort-select"
            aria-label={`Sort ${lane.title}`}
            value={activeSort ? `${activeSort.attributeKey}:${activeSort.direction}` : ""}
            onChange={(event) => {
              const [attributeKey, direction] = event.currentTarget.value.split(":");
              onSortChange(
                lane.id,
                attributeKey && (direction === "asc" || direction === "desc")
                  ? { attributeKey, direction }
                  : undefined
              );
            }}
          >
            <option value="">Manual</option>
            {Object.values(attributeDefinitions).flatMap((definition) => [
              <option key={`${definition.key}-asc`} value={`${definition.key}:asc`}>
                {(definition.shortLabel ?? definition.label ?? definition.key)} ↑
              </option>,
              <option key={`${definition.key}-desc`} value={`${definition.key}:desc`}>
                {(definition.shortLabel ?? definition.label ?? definition.key)} ↓
              </option>
            ])}
          </select>
          <span className="kanban-count">{lane.cards.length}</span>
        </div>
      </div>

      <SortableContext items={lane.cards.map((card) => card.id)} strategy={verticalListSortingStrategy}>
        <LaneDropZone laneId={lane.id}>
          {lane.cards.map((card) => (
            <SortableCard
              key={card.id}
              card={card}
              attributeDefinitions={attributeDefinitions}
              onAttributeChange={onAttributeChange}
              onOpenResource={onOpenResource}
            />
          ))}
        </LaneDropZone>
      </SortableContext>
    </section>
  );
}

function SortableCard({
  card,
  attributeDefinitions,
  onAttributeChange,
  onOpenResource
}: {
  card: KanbanCard;
  attributeDefinitions: Record<string, AttributeDefinition>;
  onAttributeChange: (cardId: string, key: string, value: string) => void;
  onOpenResource: KanbanBoardProps["onOpenResource"];
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: "card" }
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  const ResourceIcon = card.resource?.kind === "url" && card.resource.isGithub ? GitBranch : FolderOpen;

  return (
    <article className={`kanban-card${isDragging ? " is-dragging" : ""}`} ref={setNodeRef} style={style}>
      <div className="kanban-card__title-row">
        <div className="kanban-card__title-wrap">
          <button className="kanban-handle kanban-handle--card" type="button" aria-label={`Drag card ${card.title}`} {...attributes} {...listeners}>
            <GripVertical size={14} />
          </button>
          <span className="kanban-card__title">{card.title}</span>
        </div>

        {card.resource ? (
          <button
            className="kanban-open-button"
            type="button"
            onClick={() => onOpenResource(card.resource!.target, card.resource!.kind)}
            aria-label={card.resource.kind === "url" ? "Open repository" : "Open local folder"}
          >
            <ResourceIcon size={15} />
          </button>
        ) : null}
      </div>

      {card.tags.length > 0 ? (
        <div className="kanban-card__tags">
          {card.tags.map((tag) => (
            <span className="kanban-tag" key={`${card.id}-${tag}`}>
              #{tag}
            </span>
          ))}
        </div>
      ) : null}

      {card.attributes.length > 0 ? (
        <div className="kanban-card__attributes">
          {card.attributes.map((attribute) => {
            const definition = attributeDefinitions[attribute.key];
            const type = definition?.type ?? (definition?.options?.length ? "select" : "string");
            return (
              <label className={`kanban-attribute kanban-attribute--${attribute.key.toLowerCase()}`} key={`${card.id}-${attribute.key}`}>
                <strong>{definition?.label ?? attribute.key}</strong>
                {type === "select" || type === "multi" ? (
                  <select
                    value={attribute.value}
                    onChange={(event) => onAttributeChange(card.id, attribute.key, event.currentTarget.value)}
                  >
                    {definition?.options?.map((option) => (
                      <option key={`${card.id}-${attribute.key}-${option}`} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={type === "number" || type === "percent" ? "number" : "text"}
                    min={type === "percent" ? 0 : undefined}
                    max={type === "percent" ? 100 : undefined}
                    value={type === "percent" ? attribute.value.replace("%", "") : attribute.value}
                    onChange={(event) =>
                      onAttributeChange(
                        card.id,
                        attribute.key,
                        type === "percent" ? `${event.currentTarget.value}%` : event.currentTarget.value
                      )
                    }
                  />
                )}
              </label>
            );
          })}
        </div>
      ) : null}

      {card.children.length > 0 ? (
        <ul className="kanban-card__children">
          {card.children.map((child) => (
            <li key={child.id}>{child.title}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function CardOverlay({ card, attributeDefinitions }: { card: KanbanCard | null; attributeDefinitions: Record<string, AttributeDefinition> }) {
  if (!card) {
    return null;
  }

  return (
    <article className="kanban-card kanban-card--overlay">
      <div className="kanban-card__title-row">
        <div className="kanban-card__title-wrap">
          <GripVertical size={14} />
          <span className="kanban-card__title">{card.title}</span>
        </div>
      </div>

      {card.tags.length > 0 ? (
        <div className="kanban-card__tags">
          {card.tags.map((tag) => (
            <span className="kanban-tag" key={`${card.id}-${tag}`}>
              #{tag}
            </span>
          ))}
        </div>
      ) : null}

      {card.attributes.length > 0 ? (
        <div className="kanban-card__attributes">
          {card.attributes.map((attribute) => (
            <span className={`kanban-attribute kanban-attribute--${attribute.key.toLowerCase()}`} key={`${card.id}-${attribute.key}`}>
              <strong>{attributeDefinitions[attribute.key]?.label ?? attribute.key}</strong>
              <span>{attribute.value}</span>
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function KanbanBoard({ note, extensions, onPersist, onOpenResource, onRunExtensionAction }: KanbanBoardProps) {
  const [laneSorts, setLaneSorts] = useState<Record<string, ActiveLaneSort>>(() => readStoredLaneSorts(note.path));
  const [board, setBoard] = useState<KanbanBoardModel>(() => applyActiveLaneSorts(parseKanbanNote(note), readStoredLaneSorts(note.path)));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragSnapshot, setDragSnapshot] = useState<KanbanBoardModel | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCodexBar, setShowCodexBar] = useState(false);
  const [codexPrompt, setCodexPrompt] = useState("");
  const [codexMaxEdits, setCodexMaxEdits] = useState(3);
  const [codexOutput, setCodexOutput] = useState<string | null>(null);
  const [isRunningCodex, setIsRunningCodex] = useState(false);

  useEffect(() => {
    const storedSorts = readStoredLaneSorts(note.path);
    const nextBoard = applyActiveLaneSorts(parseKanbanNote(note), storedSorts);
    setLaneSorts(storedSorts);
    setBoard(nextBoard);
    setNotice(null);
    setActionError(null);

    const codexContribution = extensions.find((extension) => extension.pluginId === "codex-board-bar");
    const defaultMaxEdits = Number(codexContribution?.config?.defaultMaxEdits ?? 3);
    setCodexMaxEdits(defaultMaxEdits);
  }, [extensions, note]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

  const cardMap = useMemo(
    () => new Map(board.lanes.flatMap((lane) => lane.cards.map((card) => [card.id, card] as const))),
    [board]
  );
  const activeCard = activeId ? cardMap.get(activeId) ?? null : null;
  const codexContribution = extensions.find((extension) => extension.pluginId === "codex-board-bar") ?? null;
  const activeAutomations = extensions.filter((extension) => extension.kind === "automation" && extension.enabled);

  async function persistBoard(nextBoard: KanbanBoardModel) {
    const nextContent = serializeBoard(nextBoard);
    if (nextContent === note.content) {
      return;
    }

    setIsSaving(true);

    try {
      await onPersist(note.path, nextContent);
      setNotice(`Saved ${nextBoard.lanes.length} lanes to ${note.path}.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to persist board");
      setBoard(parseKanbanNote(note));
    } finally {
      setIsSaving(false);
    }
  }

  function handleLaneSortChange(laneId: string, sort: ActiveLaneSort | undefined) {
    const nextSorts = {
      ...laneSorts,
      ...(sort ? { [laneId]: sort } : {})
    };

    if (!sort) {
      delete nextSorts[laneId];
    }

    writeStoredLaneSorts(note.path, nextSorts);
    setLaneSorts(nextSorts);

    const nextBoard = applyActiveLaneSorts(board, nextSorts);
    setBoard(nextBoard);
    void persistBoard(nextBoard);
  }

  function handleAttributeChange(cardId: string, key: string, value: string) {
    const nextBoard = updateCardAttribute(board, cardId, key, value, laneSorts);
    setBoard(nextBoard);
    void persistBoard(nextBoard);
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
    setDragSnapshot(board);
  }

  function handleDragOver(event: DragOverEvent) {
    const overId = event.over?.id;
    if (!overId || !activeId) {
      return;
    }

    const activeIsLane = board.lanes.some((lane) => lane.id === activeId);
    if (activeIsLane) {
      return;
    }

    setBoard((currentBoard) => moveCard(currentBoard, activeId, String(overId)));
  }

  async function handleDragEnd(event: DragEndEvent) {
    const overId = event.over?.id ? String(event.over.id) : null;
    const activeIdValue = String(event.active.id);

    setActiveId(null);
    setDragSnapshot(null);

    if (!overId) {
      if (dragSnapshot) {
        setBoard(dragSnapshot);
      }
      return;
    }

    const activeLaneIndex = board.lanes.findIndex((lane) => lane.id === activeIdValue);
    const overLaneIndex = board.lanes.findIndex((lane) => lane.id === overId);

    if (activeLaneIndex !== -1 && overLaneIndex !== -1 && activeLaneIndex !== overLaneIndex) {
      const nextBoard = applyActiveLaneSorts({
        ...board,
        lanes: arrayMove(board.lanes, activeLaneIndex, overLaneIndex)
      }, laneSorts);
      setBoard(nextBoard);
      await persistBoard(nextBoard);
      return;
    }

    if (dragSnapshot && serializeBoard(dragSnapshot) !== serializeBoard(board)) {
      const nextBoard = applyActiveLaneSorts(board, laneSorts);
      setBoard(nextBoard);
      await persistBoard(nextBoard);
    }
  }

  function handleDragCancel() {
    setActiveId(null);
    if (dragSnapshot) {
      setBoard(dragSnapshot);
      setDragSnapshot(null);
    }
  }

  async function runCodex() {
    if (!codexContribution || !codexPrompt.trim()) {
      return;
    }

    setIsRunningCodex(true);
    setActionError(null);
    setCodexOutput(null);

    try {
      const result = await onRunExtensionAction({
        pluginId: codexContribution.pluginId,
        actionId: "run",
        payload: {
          prompt: codexPrompt,
          maxEdits: codexMaxEdits
        }
      });

      if (!result.ok) {
        setActionError(result.message);
      } else {
        setNotice(result.message);
      }

      setCodexOutput(result.output ?? null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to run Codex board action");
    } finally {
      setIsRunningCodex(false);
    }
  }

  return (
    <section className="kanban-board">
      <div className="kanban-board__toolbar">
        <div className="kanban-board__toolbar-left">
          <span className="kanban-board__label">Kanban</span>
          <span className="kanban-board__meta">{board.lanes.length} lanes</span>
          {activeAutomations.map((extension) => (
            <span className="kanban-board__meta kanban-board__meta--success" key={extension.pluginId}>
              {extension.name}
            </span>
          ))}
        </div>

        <div className="kanban-board__toolbar-right">
          {codexContribution ? (
            <button className="kanban-toolbar-button" type="button" onClick={() => setShowCodexBar((value) => !value)}>
              <Sparkles size={14} />
              <span>Codex</span>
            </button>
          ) : null}
          {isSaving ? (
            <span className="kanban-save-indicator">
              <LoaderCircle size={14} className="spin" />
              <span>Saving</span>
            </span>
          ) : null}
        </div>
      </div>

      {showCodexBar && codexContribution ? (
        <div className="kanban-codex-bar">
          <textarea
            className="kanban-codex-bar__prompt"
            rows={3}
            placeholder="Move stale search projects to not doing and bump important active work."
            value={codexPrompt}
            onChange={(event) => setCodexPrompt(event.target.value)}
          />
          <div className="kanban-codex-bar__actions">
            <label className="kanban-field">
              <span>Max edits</span>
              <input
                className="kanban-input"
                type="number"
                min={1}
                step={1}
                value={codexMaxEdits}
                onChange={(event) => setCodexMaxEdits(Math.max(1, Number.parseInt(event.target.value || "1", 10) || 1))}
              />
            </label>
            <button className="kanban-toolbar-button kanban-toolbar-button--primary" type="button" onClick={() => void runCodex()}>
              {isRunningCodex ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
              <span>{isRunningCodex ? "Running" : "Apply with Codex"}</span>
            </button>
          </div>
          {codexOutput ? <pre className="kanban-codex-bar__output">{codexOutput}</pre> : null}
        </div>
      ) : null}

      {notice ? <p className="kanban-message kanban-message--success">{notice}</p> : null}
      {actionError ? <p className="kanban-message kanban-message--error">{actionError}</p> : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={(event) => void handleDragEnd(event)}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={board.lanes.map((lane) => lane.id)} strategy={horizontalListSortingStrategy}>
          <div className="kanban-lanes">
            {board.lanes.map((lane) => (
              <SortableLane
                key={lane.id}
                lane={lane}
                attributeDefinitions={board.attributeDefinitions}
                {...(laneSorts[lane.id] ? { activeSort: laneSorts[lane.id] } : {})}
                onSortChange={handleLaneSortChange}
                onAttributeChange={handleAttributeChange}
                onOpenResource={onOpenResource}
              />
            ))}
          </div>
        </SortableContext>

        <DragOverlay>{activeCard ? <CardOverlay card={activeCard} attributeDefinitions={board.attributeDefinitions} /> : null}</DragOverlay>
      </DndContext>
    </section>
  );
}
