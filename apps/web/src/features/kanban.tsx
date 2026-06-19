import { useEffect, useMemo, useRef, useState } from "react";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
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
import { ChevronsLeftRight, FolderOpen, GitBranch, GripVertical, LoaderCircle, Sparkles, Timer } from "lucide-react";
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

type CardContextMenuState = {
  cardId: string;
  x: number;
  y: number;
};

type PendingPointerDrag = {
  cardId: string;
  x: number;
  y: number;
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

const kanbanCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCorners(args);
};

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

function serializeCardContent(card: Pick<KanbanCard, "linkTarget" | "title" | "attributes" | "tags" | "resource">) {
  const parts = [
    serializeLink(card.linkTarget, card.title),
    ...card.attributes.map((attribute) => `[${attribute.key}:${attribute.value}]`),
    ...card.tags.map((tag) => `#${tag}`)
  ];

  if (card.resource) {
    parts.push(`[${card.resource.kind}:${card.resource.target}]`);
  }

  return parts.join(" ");
}

function serializeBoard(model: KanbanBoardModel) {
  const sections: string[] = [];

  if (model.frontmatter) {
    sections.push(model.frontmatter);
  }

  const laneBlocks = model.lanes.map((lane) => {
    const cardLines = lane.cards.flatMap((card) => {
      const childLines = card.children.map((child) => `\t- child: ${child.rawText || serializeLink(child.linkTarget, child.title)}`);
      return [`- [${card.checked ? "x" : " "}] ${serializeCardContent(card)}`, ...childLines];
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

function collapsedLaneStorageKey(notePath: string) {
  return `obsidian-web-local:kanban-collapsed-lanes:${notePath}`;
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

function readCollapsedLanes(notePath: string): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(collapsedLaneStorageKey(notePath)) ?? "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedLanes(notePath: string, collapsed: Set<string>) {
  try {
    window.localStorage.setItem(collapsedLaneStorageKey(notePath), JSON.stringify([...collapsed]));
  } catch {
    // localStorage can be unavailable in hardened browser contexts.
  }
}

function isFocusTimerState(value: unknown): value is FocusTimerState {
  return Boolean(value && typeof value === "object" && "queue" in value && Array.isArray((value as FocusTimerState).queue));
}

function formatRemaining(endsAt: string) {
  const remaining = Math.max(0, new Date(endsAt).getTime() - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
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

function dropTargetFromPoint(x: number, y: number): string | null {
  const elements = document.elementsFromPoint(x, y);
  for (const element of elements) {
    const card = element.closest<HTMLElement>("[data-card-id]");
    if (card?.dataset.cardId) {
      return card.dataset.cardId;
    }
    const lane = element.closest<HTMLElement>("[data-lane-id]");
    if (lane?.dataset.laneId) {
      return lane.dataset.laneId;
    }
  }
  return null;
}

function orderedSelectedCards(board: KanbanBoardModel, selectedIds: Set<string>) {
  return board.lanes.flatMap((lane) => lane.cards.filter((card) => selectedIds.has(card.id)));
}

function cardIdsBetween(board: KanbanBoardModel, startId: string, endId: string) {
  const ids = board.lanes.flatMap((lane) => lane.cards.map((card) => card.id));
  const start = ids.indexOf(startId);
  const end = ids.indexOf(endId);
  if (start === -1 || end === -1) {
    return [endId];
  }
  const [from, to] = start < end ? [start, end] : [end, start];
  return ids.slice(from, to + 1);
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

function moveCardGroup(board: KanbanBoardModel, activeId: string, selectedIds: Set<string>, overId: string) {
  const idsToMove = selectedIds.has(activeId) ? selectedIds : new Set([activeId]);
  if (idsToMove.size <= 1) {
    return moveCard(board, activeId, overId);
  }

  const movingCards = orderedSelectedCards(board, idsToMove);
  if (!movingCards.length) {
    return board;
  }

  const targetLane = findLane(board, overId) ?? null;
  const target = findCardLocation(board, overId);
  const destinationLaneId = targetLane?.id ?? target?.laneId;
  if (!destinationLaneId) {
    return board;
  }

  let insertIndex = target ? target.index : board.lanes.find((lane) => lane.id === destinationLaneId)?.cards.length ?? 0;
  if (target && idsToMove.has(overId)) {
    return board;
  }

  const nextLanes = board.lanes.map((lane) => {
    const beforeLength = lane.cards.length;
    const cards = lane.cards.filter((card) => !idsToMove.has(card.id));
    if (lane.id === destinationLaneId) {
      const removedBeforeTarget = target
        ? lane.cards.slice(0, target.index).filter((card) => idsToMove.has(card.id)).length
        : 0;
      insertIndex = Math.max(0, insertIndex - removedBeforeTarget);
      cards.splice(insertIndex, 0, ...movingCards);
    }
    return beforeLength === cards.length ? lane : { ...lane, cards };
  });

  return { ...board, lanes: nextLanes };
}

function createUntitledCard(board: KanbanBoardModel): KanbanCard {
  const existingTitles = new Set(board.lanes.flatMap((lane) => lane.cards.map((card) => card.title)));
  let index = 1;
  let title = "Untitled project";
  while (existingTitles.has(title)) {
    index += 1;
    title = `Untitled project ${index}`;
  }

  return {
    id: `card-${slugify(title)}`,
    linkTarget: title,
    title,
    checked: false,
    tags: [],
    attributes: [],
    children: [],
    resource: null
  };
}

function mapCardById(board: KanbanBoardModel, cardId: string, mapper: (card: KanbanCard) => KanbanCard) {
  return {
    ...board,
    lanes: board.lanes.map((lane) => ({
      ...lane,
      cards: lane.cards.map((card) => (card.id === cardId ? mapper(card) : card))
    }))
  };
}

function updateCardTitle(board: KanbanBoardModel, cardId: string, title: string) {
  const trimmed = title.trim();
  if (!trimmed) {
    return board;
  }

  return mapCardById(board, cardId, (card) => ({
    ...card,
    title: trimmed,
    linkTarget: card.linkTarget === card.title ? trimmed : card.linkTarget
  }));
}

function duplicateCard(board: KanbanBoardModel, cardId: string) {
  const source = findCardLocation(board, cardId);
  if (!source) {
    return board;
  }

  return {
    ...board,
    lanes: board.lanes.map((lane) => {
      if (lane.id !== source.laneId) {
        return lane;
      }

      const card = lane.cards[source.index];
      if (!card) {
        return lane;
      }

      const copy = {
        ...card,
        id: `card-${slugify(card.linkTarget || card.title)}-copy-${Date.now()}`,
        title: `${card.title} copy`,
        linkTarget: card.linkTarget === card.title ? `${card.title} copy` : card.linkTarget,
        children: card.children.map((child) => ({ ...child, id: `${child.id}-copy-${Date.now()}` }))
      };
      const cards = [...lane.cards];
      cards.splice(source.index + 1, 0, copy);
      return { ...lane, cards };
    })
  };
}

function insertCardRelative(board: KanbanBoardModel, cardId: string, position: "before" | "after") {
  const source = findCardLocation(board, cardId);
  if (!source) {
    return board;
  }

  return {
    ...board,
    lanes: board.lanes.map((lane) => {
      if (lane.id !== source.laneId) {
        return lane;
      }
      const cards = [...lane.cards];
      cards.splice(position === "before" ? source.index : source.index + 1, 0, createUntitledCard(board));
      return { ...lane, cards };
    })
  };
}

function moveCardToEdge(board: KanbanBoardModel, cardId: string, edge: "top" | "bottom") {
  const source = findCardLocation(board, cardId);
  if (!source) {
    return board;
  }

  return {
    ...board,
    lanes: board.lanes.map((lane) => {
      if (lane.id !== source.laneId) {
        return lane;
      }
      const cards = [...lane.cards];
      const [card] = cards.splice(source.index, 1);
      if (!card) {
        return lane;
      }
      if (edge === "top") {
        cards.unshift(card);
      } else {
        cards.push(card);
      }
      return { ...lane, cards };
    })
  };
}

function deleteCard(board: KanbanBoardModel, cardId: string) {
  return {
    ...board,
    lanes: board.lanes.map((lane) => ({
      ...lane,
      cards: lane.cards.filter((card) => card.id !== cardId)
    }))
  };
}

function moveCardToLane(board: KanbanBoardModel, cardId: string, laneId: string) {
  const source = findCardLocation(board, cardId);
  if (!source || source.laneId === laneId) {
    return board;
  }

  const sourceLane = board.lanes.find((lane) => lane.id === source.laneId);
  const movedCard = sourceLane?.cards[source.index] ?? null;
  if (!movedCard) {
    return board;
  }

  return {
    ...board,
    lanes: board.lanes.map((lane) => {
      if (lane.id === source.laneId) {
        return { ...lane, cards: lane.cards.filter((card) => card.id !== cardId) };
      }
      if (lane.id === laneId) {
        return { ...lane, cards: [movedCard, ...lane.cards] };
      }
      return lane;
    })
  };
}

function moveCardUnderParent(board: KanbanBoardModel, cardId: string, parentId: string, sorts: Record<string, ActiveLaneSort>) {
  if (cardId === parentId) {
    return board;
  }

  const source = findCardLocation(board, cardId);
  const parentLocation = findCardLocation(board, parentId);
  if (!source || !parentLocation) {
    return board;
  }

  const sourceLane = board.lanes.find((lane) => lane.id === source.laneId);
  const movedCard = sourceLane?.cards[source.index] ?? null;
  if (!movedCard) {
    return board;
  }

  const lanesWithoutMovedCard = board.lanes.map((lane) => ({
    ...lane,
    cards: lane.cards.filter((card) => card.id !== cardId)
  }));

  const child: KanbanChild = {
    id: `child-${slugify(movedCard.linkTarget || movedCard.title)}`,
    linkTarget: movedCard.linkTarget,
    title: movedCard.title,
    rawText: serializeCardContent(movedCard)
  };

  const nextBoard = {
    ...board,
    lanes: lanesWithoutMovedCard.map((lane) => ({
      ...lane,
      cards: lane.cards.map((card) =>
        card.id === parentId
          ? {
              ...card,
              children: [...card.children, child, ...movedCard.children]
            }
          : card
      )
    }))
  };

  return applyActiveLaneSorts(nextBoard, sorts);
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
  isCollapsed,
  onSortChange,
  onToggleCollapsed,
  onAttributeChange,
  onOpenResource,
  onCardContextMenu,
  selectedCardIds,
  onCardClick,
  onCardPointerDown
}: {
  lane: KanbanLane;
  attributeDefinitions: Record<string, AttributeDefinition>;
  activeSort?: ActiveLaneSort;
  isCollapsed: boolean;
  onSortChange: (laneId: string, sort: ActiveLaneSort | undefined) => void;
  onToggleCollapsed: (laneId: string) => void;
  onAttributeChange: (cardId: string, key: string, value: string) => void;
  onOpenResource: KanbanBoardProps["onOpenResource"];
  onCardContextMenu: (cardId: string, event: React.MouseEvent<HTMLElement>) => void;
  selectedCardIds: Set<string>;
  onCardClick: (cardId: string, event: React.MouseEvent<HTMLElement>) => void;
  onCardPointerDown: (cardId: string, event: React.PointerEvent<HTMLElement>) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: lane.id,
    data: { type: "lane" }
  });
  const { setNodeRef: setCollapsedDropRef, isOver: isCollapsedOver } = useDroppable({ id: lane.id, data: { type: "lane-drop" } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  if (isCollapsed) {
    return (
      <section
        className={`kanban-lane-pin${isCollapsedOver ? " is-over" : ""}${isDragging ? " is-dragging" : ""}`}
        data-lane-id={lane.id}
        ref={(node) => {
          setNodeRef(node);
          setCollapsedDropRef(node);
        }}
        style={style}
      >
        <button className="kanban-lane-pin__button" type="button" onClick={() => onToggleCollapsed(lane.id)}>
          <span>{lane.title}</span>
          <strong>{lane.cards.length}</strong>
        </button>
      </section>
    );
  }

  return (
    <section className={`kanban-lane${isDragging ? " is-dragging" : ""}`} data-lane-id={lane.id} ref={setNodeRef} style={style}>
      <div className="kanban-lane__header">
        <div className="kanban-lane__header-copy">
          <button className="kanban-handle" type="button" aria-label={`Drag lane ${lane.title}`} {...attributes} {...listeners}>
            <GripVertical size={14} />
          </button>
          <h4>{lane.title}</h4>
        </div>
        <div className="kanban-lane__actions">
          <button
            className="kanban-lane__collapse"
            type="button"
            onClick={() => onToggleCollapsed(lane.id)}
            aria-label={`Collapse ${lane.title}`}
          >
            <ChevronsLeftRight size={14} />
          </button>
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
              onCardContextMenu={onCardContextMenu}
              isSelected={selectedCardIds.has(card.id)}
              onCardClick={onCardClick}
              onCardPointerDown={onCardPointerDown}
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
  onOpenResource,
  onCardContextMenu,
  isSelected,
  onCardClick,
  onCardPointerDown
}: {
  card: KanbanCard;
  attributeDefinitions: Record<string, AttributeDefinition>;
  onAttributeChange: (cardId: string, key: string, value: string) => void;
  onOpenResource: KanbanBoardProps["onOpenResource"];
  onCardContextMenu: (cardId: string, event: React.MouseEvent<HTMLElement>) => void;
  isSelected: boolean;
  onCardClick: (cardId: string, event: React.MouseEvent<HTMLElement>) => void;
  onCardPointerDown: (cardId: string, event: React.PointerEvent<HTMLElement>) => void;
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
  const {
    onPointerDown: sortablePointerDown,
    ...sortableListeners
  } = listeners as typeof listeners & {
    onPointerDown?: React.PointerEventHandler<HTMLElement>;
  };

  function handlePointerDown(event: React.PointerEvent<HTMLElement>) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest("button, input, select, textarea, a")) {
      onCardPointerDown(card.id, event);
      sortablePointerDown?.(event);
    }
  }

  return (
    <article
      className={`kanban-card${isDragging ? " is-dragging" : ""}${isSelected ? " is-selected" : ""}`}
      data-card-id={card.id}
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...sortableListeners}
      onContextMenu={(event) => onCardContextMenu(card.id, event)}
      onClick={(event) => onCardClick(card.id, event)}
      onPointerDown={handlePointerDown}
    >
      <div className="kanban-card__title-row">
        <div className="kanban-card__title-wrap">
          <span className="kanban-handle kanban-handle--card" aria-hidden="true">
            <GripVertical size={14} />
          </span>
          <span className="kanban-card__title">{card.title}</span>
        </div>

        {card.resource ? (
          <button
            className="kanban-open-button"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenResource(card.resource!.target, card.resource!.kind);
            }}
            onPointerDown={(event) => event.stopPropagation()}
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
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
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
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
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
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(() => readCollapsedLanes(note.path));
  const [board, setBoard] = useState<KanbanBoardModel>(() => applyActiveLaneSorts(parseKanbanNote(note), readStoredLaneSorts(note.path)));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragSnapshot, setDragSnapshot] = useState<KanbanBoardModel | null>(null);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [lastSelectedCardId, setLastSelectedCardId] = useState<string | null>(null);
  const pendingPointerDrag = useRef<PendingPointerDrag | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCodexBar, setShowCodexBar] = useState(false);
  const [codexPrompt, setCodexPrompt] = useState("");
  const [codexMaxEdits, setCodexMaxEdits] = useState(3);
  const [codexOutput, setCodexOutput] = useState<string | null>(null);
  const [isRunningCodex, setIsRunningCodex] = useState(false);
  const [showFocusTimer, setShowFocusTimer] = useState(false);
  const [focusState, setFocusState] = useState<FocusTimerState | null>(null);
  const [focusProject, setFocusProject] = useState("");
  const [focusDuration, setFocusDuration] = useState(20);
  const [focusRemaining, setFocusRemaining] = useState("");
  const [isFocusBusy, setIsFocusBusy] = useState(false);
  const [cardContextMenu, setCardContextMenu] = useState<CardContextMenuState | null>(null);
  const [contextParentId, setContextParentId] = useState("");
  const [contextLaneId, setContextLaneId] = useState("");
  const focusContribution = extensions.find((extension) => extension.pluginId === "project-focus-timer") ?? null;

  useEffect(() => {
    const storedSorts = readStoredLaneSorts(note.path);
    const storedCollapsedLanes = readCollapsedLanes(note.path);
    const nextBoard = applyActiveLaneSorts(parseKanbanNote(note), storedSorts);
    setLaneSorts(storedSorts);
    setCollapsedLanes(storedCollapsedLanes);
    setBoard(nextBoard);
    setSelectedCardIds(new Set());
    setLastSelectedCardId(null);
    setNotice(null);
    setActionError(null);

    const codexContribution = extensions.find((extension) => extension.pluginId === "codex-board-bar");
    const defaultMaxEdits = Number(codexContribution?.config?.defaultMaxEdits ?? 3);
    setCodexMaxEdits(defaultMaxEdits);

    const focusContribution = extensions.find((extension) => extension.pluginId === "project-focus-timer");
    const defaultDuration = Number(focusContribution?.config?.durationMinutes ?? 20);
    setFocusDuration(defaultDuration);
  }, [extensions, note]);

  useEffect(() => {
    if (!focusContribution) {
      setFocusState(null);
      return;
    }

    const contribution = focusContribution;
    let isActive = true;
    async function loadFocusStatus() {
      try {
        const result = await onRunExtensionAction({
          pluginId: contribution.pluginId,
          actionId: "status"
        });
        if (isActive && result.ok && isFocusTimerState(result.data)) {
          setFocusState(result.data);
          setFocusDuration(result.data.durationMinutes);
        }
      } catch {
        if (isActive) {
          setFocusState(null);
        }
      }
    }

    void loadFocusStatus();
    return () => {
      isActive = false;
    };
  }, [focusContribution, onRunExtensionAction]);

  useEffect(() => {
    const update = () => {
      setFocusRemaining(focusState?.current ? formatRemaining(focusState.current.endsAt) : "");
    };
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [focusState?.current]);

  useEffect(() => {
    function handlePointerUp(event: PointerEvent) {
      const pending = pendingPointerDrag.current;
      pendingPointerDrag.current = null;
      if (!pending) {
        return;
      }

      const distance = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
      if (distance < 24) {
        return;
      }

      const dropTargetId = dropTargetFromPoint(event.clientX, event.clientY);
      if (!dropTargetId || dropTargetId === pending.cardId) {
        return;
      }

      const nextBoard = applyActiveLaneSorts(
        moveCardGroup(dragSnapshot ?? board, pending.cardId, selectedCardIds, dropTargetId),
        laneSorts
      );
      if (serializeBoard(nextBoard) === serializeBoard(dragSnapshot ?? board)) {
        return;
      }

      setBoard(nextBoard);
      void persistBoard(nextBoard);
    }

    window.addEventListener("pointerup", handlePointerUp, { capture: true });
    return () => window.removeEventListener("pointerup", handlePointerUp, { capture: true });
  }, [board, dragSnapshot, laneSorts, selectedCardIds]);

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
  const allCards = useMemo(() => board.lanes.flatMap((lane) => lane.cards), [board]);
  const projectNames = useMemo(() => allCards.map((card) => card.linkTarget || card.title).filter(Boolean), [allCards]);
  const activeCard = activeId ? cardMap.get(activeId) ?? null : null;
  const contextCard = cardContextMenu ? cardMap.get(cardContextMenu.cardId) ?? null : null;
  const parentCandidates = allCards.filter((card) => card.id !== cardContextMenu?.cardId);
  const codexContribution = extensions.find((extension) => extension.pluginId === "codex-board-bar") ?? null;
  const activeAutomations = extensions.filter((extension) => extension.kind === "automation" && extension.enabled);

  useEffect(() => {
    if (!cardContextMenu) {
      return;
    }

    const closeMenu = () => setCardContextMenu(null);
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenu);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenu);
    };
  }, [cardContextMenu]);

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

  function handleToggleCollapsed(laneId: string) {
    const next = new Set(collapsedLanes);
    if (next.has(laneId)) {
      next.delete(laneId);
    } else {
      next.add(laneId);
    }
    writeCollapsedLanes(note.path, next);
    setCollapsedLanes(next);
  }

  function handleCardClick(cardId: string, event: React.MouseEvent<HTMLElement>) {
    if (event.defaultPrevented) {
      return;
    }

    if (event.shiftKey && lastSelectedCardId) {
      const range = cardIdsBetween(board, lastSelectedCardId, cardId);
      setSelectedCardIds((current) => new Set([...current, ...range]));
      return;
    }

    if (event.metaKey || event.ctrlKey) {
      setSelectedCardIds((current) => {
        const next = new Set(current);
        if (next.has(cardId)) {
          next.delete(cardId);
        } else {
          next.add(cardId);
        }
        return next;
      });
      setLastSelectedCardId(cardId);
      return;
    }

    setSelectedCardIds(new Set([cardId]));
    setLastSelectedCardId(cardId);
  }

  function handleCardPointerDown(cardId: string, event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button, input, select, textarea, a")) {
      return;
    }
    pendingPointerDrag.current = {
      cardId,
      x: event.clientX,
      y: event.clientY
    };
  }

  function handleAttributeChange(cardId: string, key: string, value: string) {
    const nextBoard = updateCardAttribute(board, cardId, key, value, laneSorts);
    setBoard(nextBoard);
    void persistBoard(nextBoard);
  }

  function handleCardContextMenu(cardId: string, event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setCardContextMenu({
      cardId,
      x: Math.min(event.clientX, window.innerWidth - 280),
      y: Math.min(event.clientY, window.innerHeight - 180)
    });
    setContextParentId("");
    setContextLaneId("");
  }

  function handleMoveUnderParent() {
    if (!cardContextMenu || !contextParentId) {
      return;
    }

    const nextBoard = moveCardUnderParent(board, cardContextMenu.cardId, contextParentId, laneSorts);
    setCardContextMenu(null);
    setContextParentId("");
    setBoard(nextBoard);
    void persistBoard(nextBoard);
  }

  function persistContextBoard(nextBoard: KanbanBoardModel) {
    setCardContextMenu(null);
    setContextParentId("");
    setContextLaneId("");
    setBoard(nextBoard);
    void persistBoard(nextBoard);
  }

  function handleEditContextCard() {
    if (!contextCard) {
      return;
    }

    const nextTitle = window.prompt("Edit card", contextCard.title);
    if (nextTitle === null) {
      return;
    }

    persistContextBoard(updateCardTitle(board, contextCard.id, nextTitle));
  }

  function handleCopyLinkToCard() {
    if (!contextCard) {
      return;
    }

    void navigator.clipboard.writeText(`[[${note.path}#${contextCard.title}]]`);
    setCardContextMenu(null);
  }

  function handleMoveToLane() {
    if (!cardContextMenu || !contextLaneId) {
      return;
    }

    persistContextBoard(moveCardToLane(board, cardContextMenu.cardId, contextLaneId));
  }

  function handleDragStart(event: DragStartEvent) {
    const nextActiveId = String(event.active.id);
    setActiveId(nextActiveId);
    setDragSnapshot(board);
    if (cardMap.has(nextActiveId) && !selectedCardIds.has(nextActiveId)) {
      setSelectedCardIds(new Set([nextActiveId]));
      setLastSelectedCardId(nextActiveId);
    }
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

    setBoard((currentBoard) => moveCardGroup(currentBoard, activeId, selectedCardIds, String(overId)));
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

    if (cardMap.has(activeIdValue)) {
      const sourceBoard = dragSnapshot ?? board;
      const nextBoard = applyActiveLaneSorts(
        moveCardGroup(sourceBoard, activeIdValue, selectedCardIds, overId),
        laneSorts
      );
      if (serializeBoard(nextBoard) !== serializeBoard(sourceBoard)) {
        setBoard(nextBoard);
        await persistBoard(nextBoard);
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

  async function runFocusAction(actionId: string, payload?: Record<string, unknown>) {
    if (!focusContribution) {
      return;
    }

    setIsFocusBusy(true);
    setActionError(null);

    try {
      const requestPayload = payload
        ? {
            pluginId: focusContribution.pluginId,
            actionId,
            payload
          }
        : {
            pluginId: focusContribution.pluginId,
            actionId
          };
      const result = await onRunExtensionAction({
        ...requestPayload
      });

      if (!result.ok) {
        setActionError(result.message);
      } else {
        setNotice(result.message);
      }

      if (isFocusTimerState(result.data)) {
        setFocusState(result.data);
        setFocusDuration(result.data.durationMinutes);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to run focus timer action");
    } finally {
      setIsFocusBusy(false);
    }
  }

  function focusPayload() {
    return {
      project: focusProject.trim(),
      note: "",
      durationMinutes: focusDuration
    };
  }

  async function startFocusBlock() {
    if (!focusProject.trim()) {
      setActionError("Choose a project first.");
      return;
    }
    await runFocusAction("start", focusPayload());
  }

  async function queueFocusBlock() {
    if (!focusProject.trim()) {
      setActionError("Choose a project first.");
      return;
    }
    await runFocusAction("queue", focusPayload());
  }

  async function recordFocusBlock() {
    if (!focusProject.trim()) {
      setActionError("Choose a project first.");
      return;
    }
    await runFocusAction("record", focusPayload());
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
          {focusContribution ? (
            <button className="kanban-toolbar-button" type="button" onClick={() => setShowFocusTimer((value) => !value)}>
              <Timer size={14} />
              <span>Focus</span>
            </button>
          ) : null}
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

      {showFocusTimer && focusContribution ? (
        <div className="kanban-focus-timer">
          {focusState?.current ? (
            <div className="kanban-focus-timer__active">
              <div>
                <strong>{focusState.current.project}</strong>
                <span>{focusState.current.note || "Focus block"}</span>
              </div>
              <code>{focusRemaining}</code>
              <button type="button" disabled={isFocusBusy} onClick={() => void runFocusAction("finish")}>
                Finish
              </button>
              <button type="button" disabled={isFocusBusy} onClick={() => void runFocusAction("abandon")}>
                Abandon
              </button>
            </div>
          ) : (
            <div className="kanban-focus-timer__form">
              <input
                className="kanban-focus-timer__project"
                list="kanban-focus-projects"
                placeholder="Project"
                value={focusProject}
                onChange={(event) => setFocusProject(event.currentTarget.value)}
              />
              <datalist id="kanban-focus-projects">
                {projectNames.map((project) => (
                  <option key={project} value={project} />
                ))}
              </datalist>
              <input
                className="kanban-focus-timer__duration"
                type="number"
                min={1}
                step={1}
                value={focusDuration}
                onChange={(event) => setFocusDuration(Math.max(1, Number.parseInt(event.currentTarget.value || "20", 10) || 20))}
              />
              <button type="button" disabled={isFocusBusy} onClick={() => void startFocusBlock()}>
                Start
              </button>
              <button type="button" disabled={isFocusBusy} onClick={() => void queueFocusBlock()}>
                Queue
              </button>
              <button type="button" disabled={isFocusBusy} onClick={() => void recordFocusBlock()}>
                Record
              </button>
            </div>
          )}

          {focusState?.queue.length ? (
            <div className="kanban-focus-timer__queue">
              {focusState.queue.map((item, index) => (
                <div className="kanban-focus-timer__queue-row" key={`${item.project}-${index}`}>
                  <span>{item.project}</span>
                  <small>{item.note || `${item.durationMinutes}m`}</small>
                  <button type="button" disabled={isFocusBusy || Boolean(focusState.current)} onClick={() => void runFocusAction("startQueued", { index })}>
                    Start
                  </button>
                  <button type="button" disabled={isFocusBusy} onClick={() => void runFocusAction("removeQueued", { index })}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

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

      {cardContextMenu && contextCard ? (
        <div
          className="kanban-context-menu"
          style={{ left: cardContextMenu.x, top: cardContextMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="kanban-context-menu__title">{contextCard.title}</div>
          <div className="kanban-context-menu__items">
            <button type="button" onClick={handleEditContextCard}>Edit card</button>
            <button type="button" disabled>New note from card</button>
            <button type="button" onClick={handleCopyLinkToCard}>Copy link to card</button>
            <button type="button" disabled>Split card</button>
            <button type="button" onClick={() => persistContextBoard(duplicateCard(board, contextCard.id))}>Duplicate card</button>
            <button type="button" onClick={() => persistContextBoard(insertCardRelative(board, contextCard.id, "before"))}>Insert card before</button>
            <button type="button" onClick={() => persistContextBoard(insertCardRelative(board, contextCard.id, "after"))}>Insert card after</button>
            <button type="button" onClick={() => persistContextBoard(moveCardToEdge(board, contextCard.id, "top"))}>Move to top</button>
            <button type="button" onClick={() => persistContextBoard(moveCardToEdge(board, contextCard.id, "bottom"))}>Move to bottom</button>
            <button type="button" disabled>Archive card</button>
            <button type="button" onClick={() => persistContextBoard(deleteCard(board, contextCard.id))}>Delete card</button>
            <button type="button" disabled>Add date</button>
            <button type="button" disabled>Add time</button>
          </div>
          <label className="kanban-context-menu__field">
            <span>Move under another project</span>
            <select value={contextParentId} onChange={(event) => setContextParentId(event.currentTarget.value)}>
              <option value="">Choose project</option>
              {parentCandidates.map((card) => (
                <option value={card.id} key={card.id}>
                  {card.title}
                </option>
            ))}
          </select>
        </label>
          <button
            className="kanban-toolbar-button kanban-toolbar-button--primary"
            type="button"
            disabled={!contextParentId}
            onClick={handleMoveUnderParent}
          >
            Move
          </button>
          <label className="kanban-context-menu__field">
            <span>Move to list</span>
            <select value={contextLaneId} onChange={(event) => setContextLaneId(event.currentTarget.value)}>
              <option value="">Choose list</option>
              {board.lanes.map((lane) => (
                <option value={lane.id} key={lane.id}>
                  {lane.title}
                </option>
              ))}
            </select>
          </label>
          <button
            className="kanban-toolbar-button kanban-toolbar-button--primary"
            type="button"
            disabled={!contextLaneId}
            onClick={handleMoveToLane}
          >
            Move to list
          </button>
        </div>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={kanbanCollisionDetection}
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
                isCollapsed={collapsedLanes.has(lane.id)}
                onSortChange={handleLaneSortChange}
                onToggleCollapsed={handleToggleCollapsed}
                onAttributeChange={handleAttributeChange}
                onOpenResource={onOpenResource}
                onCardContextMenu={handleCardContextMenu}
                selectedCardIds={selectedCardIds}
                onCardClick={handleCardClick}
                onCardPointerDown={handleCardPointerDown}
              />
            ))}
          </div>
        </SortableContext>

        <DragOverlay>{activeCard ? <CardOverlay card={activeCard} attributeDefinitions={board.attributeDefinitions} /> : null}</DragOverlay>
      </DndContext>
    </section>
  );
}
