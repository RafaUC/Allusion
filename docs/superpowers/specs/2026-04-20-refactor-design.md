# Refactor Design: Codebase Manageability

**Date:** 2026-04-20  
**Goal:** Make future changes easier by splitting large files into focused modules with clear separation of concerns. Target: no file over 500 lines where possible.  
**Approach:** Repository pattern for the backend layer; pragmatic file splitting for stores and UI. Layers are refactored one at a time to allow incremental merging.

---

## Motivation

The codebase has several files that have grown to 900–2,800 lines by accumulating unrelated responsibilities. This makes changes harder to reason about and increases merge conflict surface. The refactor does not change public interfaces — all existing imports continue to work via barrel re-exports.

---

## Guiding Principles

- **No interface churn.** All public exports remain accessible at their current import paths via `index.ts` barrels.
- **Layer at a time.** Each layer (backend → main process → stores → UI) is tackled in sequence so the branch stays mergeable.
- **Sub-modules export logic, not state.** MobX `@observable` state stays in the store's `index.ts`; sub-modules export plain functions or helper classes the store calls into.
- **500-line target.** Not a hard rule, but the default nudge when deciding whether to extract.

---

## Layer 1: Backend (`src/backend/backend.ts`, 2,829 lines)

The `Backend` class implements the `DataStorage` interface from `src/api/`. That interface is unchanged. The class becomes a thin coordinator that composes repository objects.

**New structure:**
```
src/backend/
├── backend.ts                    # thin coordinator, ~150 lines
├── db.ts                         # Kysely connection, schema setup, migrations
├── repositories/
│   ├── FileRepository.ts         # file CRUD + filter queries
│   ├── TagRepository.ts          # tag CRUD, hierarchy, implications
│   ├── LocationRepository.ts     # location CRUD
│   ├── SearchRepository.ts       # saved searches
│   └── SemanticRepository.ts     # embeddings + semantic search
└── query-builder.ts              # shared filter/sort query helpers
```

Each repository:
- Takes the Kysely `db` instance in its constructor
- Owns all SQL queries for its domain
- Has no knowledge of other repositories (cross-domain coordination stays in `backend.ts`)

---

## Layer 2: Main Process (`src/main.ts`, 906 lines)

`main.ts` becomes a ~80-line entry point that imports and wires the modules below.

**New structure:**
```
src/main/
├── window.ts          # BrowserWindow creation, focus, lifecycle
├── menu.ts            # application menu builder
├── updater.ts         # auto-update logic
├── preferences.ts     # read/write preferences JSON to disk
└── ipc-handlers.ts    # registers all IPC handlers, coordinates above modules

src/main.ts            # entry point: app.whenReady(), imports main/
```

`ipc-handlers.ts` centralises IPC registration so message handlers aren't scattered across files.

---

## Layer 3: Stores

Sub-modules export plain functions/helpers. The `index.ts` owns all `@observable` state and delegates heavy logic to sub-modules.

### FileStore (`src/frontend/stores/FileStore.ts`, 2,252 lines)

```
src/frontend/stores/FileStore/
├── index.ts        # FileStore class (~200 lines), composes sub-modules
├── search.ts       # filter building, semantic search, pagination logic
├── selection.ts    # file selection state helpers, clipboard
└── operations.ts   # tagging, metadata writes, file system operations
```

### UiStore (`src/frontend/stores/UiStore.ts`, 1,672 lines)

```
src/frontend/stores/UiStore/
├── index.ts        # UiStore class (~150 lines)
├── theme.ts        # theme switching + thumbnail settings
├── preferences.ts  # settings persistence (read/write to disk)
└── hotkeys.ts      # hotkey maps and handler registration
```

### LocationStore (`src/frontend/stores/LocationStore.ts`, 882 lines)

```
src/frontend/stores/LocationStore/
├── index.ts        # LocationStore class (~200 lines)
├── watcher.ts      # filesystem watching logic
└── indexer.ts      # file indexing, metadata scanning
```

---

## Layer 4: UI Components

Same barrel pattern. Sub-components are extracted at natural seams.

### TagsTree (`src/frontend/containers/TagsTree.tsx`, 877 lines)

```
src/frontend/containers/TagsTree/
├── index.tsx         # main component, composes below (~150 lines)
├── TreeNode.tsx      # single node rendering + expand/collapse
├── DragDrop.ts       # drag-drop hooks and logic
└── ContextMenu.tsx   # right-click menu actions
```

### FileExtraPropertiesEditor (`src/frontend/components/FileExtraPropertiesEditor.tsx`, 812 lines)

```
src/frontend/components/FileExtraPropertiesEditor/
├── index.tsx         # form shell (~150 lines)
├── PropertyField.tsx # single property field (type-specific rendering)
└── PropertyForm.tsx  # form state and validation logic
```

### Follow-up (lower priority, same treatment)

- `FileTagsEditor.tsx` (660 lines)
- `HelpCenter.tsx` (659 lines)
- `LocationsPanel/index.tsx` (634 lines)
- `TagSelector.tsx` (626 lines)

---

## Execution Order

1. Backend repositories (most isolated layer, clearest domain boundaries)
2. Main process modules (also isolated, no MobX complexity)
3. FileStore sub-folder
4. LocationStore sub-folder
5. UiStore sub-folder
6. TagsTree sub-folder
7. FileExtraPropertiesEditor sub-folder
8. Remaining large UI components

Each step is a self-contained PR. At no point does a step break the build for subsequent steps.

---

## Out of Scope

- Changing public `DataStorage` interface contracts
- Introducing new state management patterns (Redux, Zustand, etc.)
- Moving to a feature-domain folder structure
- Refactoring files under 500 lines unless touched during a step
