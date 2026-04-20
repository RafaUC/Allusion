# Codebase Manageability Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split eight files (900–2,800 lines each) into focused modules so each file has one clear responsibility and stays under 500 lines where possible.

**Architecture:** Repository pattern for `backend.ts` — a thin coordinator delegates to domain-specific repository classes. Pragmatic folder-splits for stores and UI — each folder has an `index.ts` that re-exports the same surface so no callers change.

**Tech Stack:** TypeScript (strict), Kysely ORM, MobX, React, Electron, Jest (tests run against the legacy Dexie backend in `src/backend/_deprecated/`, so `yarn test` doesn't cover the new backend — use `npx tsc --noEmit` as the correctness check for backend and store refactors).

**Branch:** `refactor/codebase-manageability`

---

## File Map

### Created
- `src/backend/db.ts` — Kysely connection setup, PRAGMA config, shared DB utilities
- `src/backend/query-builder.ts` — filter/sort query helpers, shared types
- `src/backend/repositories/FileRepository.ts` — file CRUD, search, pagination
- `src/backend/repositories/TagRepository.ts` — tag CRUD, hierarchy, implications
- `src/backend/repositories/LocationRepository.ts` — location CRUD
- `src/backend/repositories/SearchRepository.ts` — saved search CRUD
- `src/backend/repositories/ExtraPropertyRepository.ts` — extra property CRUD
- `src/backend/repositories/SemanticRepository.ts` — embeddings, semantic search
- `src/main/window.ts` — BrowserWindow creation and lifecycle
- `src/main/menu.ts` — application menu builder
- `src/main/updater.ts` — auto-update logic
- `src/main/preferences.ts` — read/write preferences JSON
- `src/main/ipc-handlers.ts` — all MainMessenger.on* registrations
- `src/frontend/stores/FileStore/search.ts` — filter building, semantic search, pagination logic
- `src/frontend/stores/FileStore/selection.ts` — file selection helpers, clipboard
- `src/frontend/stores/FileStore/operations.ts` — tagging, metadata writes, file ops
- `src/frontend/stores/UiStore/theme.ts` — theme switching, thumbnail settings
- `src/frontend/stores/UiStore/preferences.ts` — settings persistence
- `src/frontend/stores/UiStore/hotkeys.ts` — hotkey maps and handler registration
- `src/frontend/stores/LocationStore/watcher.ts` — filesystem watching logic
- `src/frontend/stores/LocationStore/indexer.ts` — file indexing, metadata scanning
- `src/frontend/containers/Outliner/TagsPanel/TagsTree/TreeNode.tsx` — single node rendering
- `src/frontend/containers/Outliner/TagsPanel/TagsTree/DragDrop.ts` — drag-drop hooks
- `src/frontend/containers/Outliner/TagsPanel/TagsTree/ContextMenu.tsx` — context menu actions
- `src/frontend/components/FileExtraPropertiesEditor/PropertyField.tsx` — field rendering
- `src/frontend/components/FileExtraPropertiesEditor/PropertyForm.tsx` — form state/validation

### Modified (thinned to coordinator/barrel)
- `src/backend/backend.ts` — keeps class shell + delegation, drops extracted code
- `src/main.ts` — entry point only, imports from `src/main/`
- `src/frontend/stores/FileStore.ts` → becomes `src/frontend/stores/FileStore/index.ts`
- `src/frontend/stores/UiStore.ts` → becomes `src/frontend/stores/UiStore/index.ts`
- `src/frontend/stores/LocationStore.ts` → becomes `src/frontend/stores/LocationStore/index.ts`
- `src/frontend/containers/Outliner/TagsPanel/TagsTree.tsx` → becomes `TagsTree/index.tsx`
- `src/frontend/components/FileExtraPropertiesEditor.tsx` → becomes folder `index.tsx`

---

## Task 1: Establish baseline

**Files:**
- Read: `src/backend/backend.ts`

- [ ] **Step 1: Confirm tests pass**

```bash
yarn test
```
Expected: `Tests: 25 passed, 25 total`

- [ ] **Step 2: Confirm TypeScript compiles cleanly**

```bash
npx tsc --noEmit
```
Expected: no errors (or note any pre-existing errors so they aren't confused with regressions)

---

## Task 2: Extract `db.ts` — connection setup and shared DB utilities

The `init()` method in `backend.ts` (~lines 118–195) sets up the Kysely connection, runs PRAGMAs, and calls `migrateToLatest`. These helpers live alongside it:
- `getSqliteMaxVariables()` (exported, line 1873)
- `computeBatchSize()` (exported, line 1884)
- `PadString()` (line 1901), `stableHash()` (line 1905), `generateSeed()` (line 1916)

**Files:**
- Create: `src/backend/db.ts`
- Modify: `src/backend/backend.ts`

- [ ] **Step 1: Create `src/backend/db.ts`**

```typescript
import SQLite from 'better-sqlite3';
import {
  Kysely,
  SqliteDialect,
  ParseJSONResultsPlugin,
  CamelCasePlugin,
  sql,
} from 'kysely';
import { kyselyLogger, PAD_STRING_LENGTH } from './config';
import { AllusionDB_SQL } from './schemaTypes';
import { IS_DEV } from 'common/process';

// Defined here because it's used inside initDB's Kysely config
const USE_QUERY_LOGGER = false ? IS_DEV : false;

export function PadString(str: string): string {
  // [move PadString body here verbatim from backend.ts line 1901]
}

export function stableHash(id: string, seed: number): number {
  // [move stableHash body here verbatim from backend.ts line 1905]
}

export function generateSeed(): number {
  // [move generateSeed body here verbatim from backend.ts line 1916]
}

export async function getSqliteMaxVariables(db: Kysely<AllusionDB_SQL>): Promise<number> {
  // [move getSqliteMaxVariables body here verbatim from backend.ts line 1873]
}

export function computeBatchSize(maxVars: number, sampleObject?: Record<string, any>): number {
  // [move computeBatchSize body here verbatim from backend.ts line 1884]
}

export interface DBInitResult {
  db: Kysely<AllusionDB_SQL>;
  sqlite: SQLite.Database;
}

export async function initDB(dbPath: string): Promise<DBInitResult> {
  console.info(`SQLite3: Initializing database "${dbPath}"...`);

  // [move the DB creation block from init() lines 129–169 verbatim]
  // Stops after creating the Kysely instance and applying PRAGMAs.
  // Do NOT move migrateToLatest here — it stays in Backend.init() since it depends on mode.
  // Returns { db, sqlite }
}
```

**Important:** `USE_QUERY_LOGGER` is currently a `const` inside `backend.ts`. Either export it from `backend.ts` or move it to `db.ts` — whichever keeps the import graph clean. Moving it to `db.ts` is cleaner.

- [ ] **Step 2: Move the function bodies**

Open `src/backend/backend.ts`. For each function listed above:
1. Cut the function body from `backend.ts`
2. Paste into the matching stub in `db.ts`
3. Add the import in `backend.ts`: `import { PadString, stableHash, generateSeed, getSqliteMaxVariables, computeBatchSize, initDB } from './db';`
4. Remove the now-duplicate `export async function getSqliteMaxVariables` and `export function computeBatchSize` from `backend.ts`

- [ ] **Step 3: Update `init()` to call `initDB()`**

In `backend.ts`, replace the DB setup block inside `init()` with:
```typescript
const { db, sqlite } = await initDB(dbPath);
this.#db = db;
this.#sqlite = sqlite;
this.#dbPath = dbPath;
// migrateToLatest stays here — it depends on mode:
if (mode === 'default' || mode === 'migrate') {
  await migrateToLatest(db, { jsonToImport });
}
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/backend/db.ts src/backend/backend.ts
git commit -m "refactor(backend): extract db connection setup and utilities to db.ts"
```

---

## Task 3: Extract `query-builder.ts` — filter and sort query helpers

These functions are currently at the bottom of `backend.ts` (~lines 2072–2829):
- `exampleFileDTO` (line 2072) — used internally for type inference
- `isFileDTOPropString()` (line 2093)
- `getOrderColumnExpression()` (exported, line 2226)
- `ConditionWithConjunction<T>` type (line 2268)
- `applyFileFilters()` (line 2272)
- `expressionFromNode()` (line 2287)
- `expressionFromCriteria` (line 2304)
- `applyStringCondition()` (line 2322)
- `applyNumberCondition()` (line 2352)
- `applyPagination()` — likely in this block too; locate it in the file
- `MustIncludeFiles` type (used in `applyFileFilters` signature) — move it too
- `computeSampleTimestamps()` (line 1979), `meanPoolEmbeddings()` (line 1991) — these are semantic helpers; they should have been moved in Task 4. If they weren't, move them to `SemanticRepository.ts` now.

**Files:**
- Create: `src/backend/query-builder.ts`
- Modify: `src/backend/backend.ts`

- [ ] **Step 1: Create `src/backend/query-builder.ts`**

```typescript
import {
  Kysely,
  sql,
  SelectQueryBuilder,
  SqlBool,
  ExpressionBuilder,
  OrderByDirection,
  AnyColumn,
  Expression,
  RawBuilder,
} from 'kysely';
import {
  OrderBy,
  OrderDirection,
  ConditionDTO,
  StringOperatorType,
  NumberOperatorType,
  ArrayOperatorType,
  ExtraPropertyOperatorType,
  isNumberOperator,
  isStringOperator,
  PropertyKeys,
  StringProperties,
  SearchConjunction,
  ConditionGroupDTO,
  PaginationDirection,
  Cursor,
  IndexableType,
} from 'src/api/data-storage-search';
import { FileDTO } from 'src/api/file';
import { ID } from 'src/api/id';
import { AllusionDB_SQL } from './schemaTypes';
import { PAD_STRING_LENGTH } from './config';

// [Move all the query builder functions and types here verbatim]
// Exports: getOrderColumnExpression, ConditionWithConjunction, applyFileFilters, applyPagination
// Everything else can remain unexported (module-private)
```

- [ ] **Step 2: Cut and paste the functions**

Cut lines ~2072–2829 from `backend.ts` and paste into `query-builder.ts`. Add to `backend.ts`:
```typescript
import {
  getOrderColumnExpression,
  ConditionWithConjunction,
  applyFileFilters,
  applyPagination,
} from './query-builder';
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/backend/query-builder.ts src/backend/backend.ts
git commit -m "refactor(backend): extract query builder and filter helpers to query-builder.ts"
```

---

## Task 4: Extract `SemanticRepository.ts`

All semantic search code — the largest self-contained domain in `backend.ts`.

Methods to move (all currently on the `Backend` class):
- `semanticSearchByText()` (line 503)
- `semanticSearchByImage()` (line 514)
- `warmupSemanticModel()` (line 531)
- `reindexSemanticEmbeddings()` (line 535)
- `embedFileFromThumbnail()` (line 561)
- `fetchSemanticStatus()` (line 592)
- `getSemanticEmbeddingDimension()` (private, line 612)
- `semanticSearchByEmbedding()` (private, line 626)
- `semanticSearchByEmbeddingSqliteVector()` (private, line 699)
- `ensureEmbeddingForFile()` (private, line 758)
- `embedVideoSemanticEmbedding()` (private, line 858)
- `enqueueSemanticEmbeddings()` (private, line 1135)
- `takeNextSemanticQueueFileId()` (private, line 1166)
- `processSemanticEmbeddingQueue()` (private, line 1177)
- `tryLoadSqliteVectorExtension()` (private, line 197)
- `resolveSqliteVectorExtensionPath()` (private, line 221)
- `resolveBundledFfmpegPath()` (private, line 251)
- `getBundledFfmpegPath()` (private, line 273)
- `ensureSqliteVectorInitialized()` (private, line 280)
- `ensureSqliteVectorQuantized()` (private, line 308)

State to move (currently `Backend` private fields):
- `#semanticEmbedder` (line 105)
- `#semanticIndexQueue` (line 106)
- `#sqliteVectorAvailable` (line 101)
- `#sqliteVectorInitializedDimension` (line 102)
- `#sqliteVectorQuantizeDirty` (line 103)
- `#semanticEmbeddingDimension` (line 104)
- `#bundledFfmpegPath` (resolved inside `getBundledFfmpegPath`)

**Files:**
- Create: `src/backend/repositories/SemanticRepository.ts`
- Modify: `src/backend/backend.ts`

- [ ] **Step 1: Create `src/backend/repositories/SemanticRepository.ts`**

```typescript
import SQLite from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Kysely, sql } from 'kysely';
import { AllusionDB_SQL } from '../schemaTypes';
import { FileDTO } from 'src/api/file';
import { ID } from 'src/api/id';
import { SemanticSearchOptions, SemanticSearchStatus } from 'src/api/semantic-search';
import { float32BlobToVector, SemanticEmbedder, sourceHashForFile, vectorToFloat32Blob } from '../semantic';
import { isFileExtensionVideo } from 'common/fs';

const SQLITE_VECTOR_TABLE = 'file_embeddings';
const SQLITE_VECTOR_COLUMN = 'embedding_blob';
const SEMANTIC_VIDEO_FRAME_COUNT = 4;
const SEMANTIC_VIDEO_FRAME_SAMPLE_RATIOS = [0.1, 0.35, 0.6, 0.85] as const;

export class SemanticRepository {
  readonly #db: Kysely<AllusionDB_SQL>;
  readonly #sqlite: SQLite.Database;
  readonly #semanticEmbedder = new SemanticEmbedder();
  readonly #semanticIndexQueue = new Set<ID>();
  #sqliteVectorAvailable = false;
  #sqliteVectorInitializedDimension: number | undefined;
  #sqliteVectorQuantizeDirty = true;
  #semanticEmbeddingDimension: number | undefined;
  #bundledFfmpegPath: string | null | undefined;

  constructor(db: Kysely<AllusionDB_SQL>, sqlite: SQLite.Database) {
    this.#db = db;
    this.#sqlite = sqlite;
    this.#sqliteVectorAvailable = this.tryLoadSqliteVectorExtension(sqlite);
  }

  // [paste all the semantic methods here — keep them exactly as they are]
  // The only change: replace `this.#db` references (already use #db field name)
  // and replace `this.#sqlite` references.
}
```

- [ ] **Step 2: Move the method bodies**

For each method in the list above:
1. Cut the method from `backend.ts`
2. Paste inside `SemanticRepository` class body in the new file
3. Methods that reference `this.#db` or `this.#sqlite` — they already use private field syntax, just rename to match the repo's fields (they're the same names, so no change needed)

- [ ] **Step 3: Add repository field to `Backend` and delegate**

In `backend.ts`:

```typescript
import { SemanticRepository } from './repositories/SemanticRepository';

export default class Backend implements DataStorage {
  // ... existing fields ...
  #semantic!: SemanticRepository;

  async init(...) {
    // ... existing init code ...
    this.#semantic = new SemanticRepository(this.#db, this.#sqlite);
  }

  async semanticSearchByText(query: string, options?: SemanticSearchOptions): Promise<FileDTO[]> {
    return this.#semantic.semanticSearchByText(query, options);
  }
  async semanticSearchByImage(fileId: ID, options?: SemanticSearchOptions): Promise<FileDTO[]> {
    return this.#semantic.semanticSearchByImage(fileId, options);
  }
  async warmupSemanticModel(): Promise<void> {
    return this.#semantic.warmupSemanticModel();
  }
  async reindexSemanticEmbeddings(fileIds?: ID[]): Promise<number> {
    return this.#semantic.reindexSemanticEmbeddings(fileIds);
  }
  async embedFileFromThumbnail(fileId: ID, thumbnailPath: string): Promise<void> {
    return this.#semantic.embedFileFromThumbnail(fileId, thumbnailPath);
  }
  async fetchSemanticStatus(): Promise<SemanticSearchStatus> {
    return this.#semantic.fetchSemanticStatus();
  }
}
```

- [ ] **Step 4: Handle `enqueueSemanticEmbeddings` call in `createFilesFromPath`**

`createFilesFromPath()` (line 1105) calls `this.enqueueSemanticEmbeddings(fileIds)` after inserting files. After moving the method, update that call to:
```typescript
this.#semantic.enqueueSemanticEmbeddings(fileIds);
```
Make `enqueueSemanticEmbeddings` public on `SemanticRepository` (remove the `private` modifier).

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit
```
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/backend/repositories/SemanticRepository.ts src/backend/backend.ts
git commit -m "refactor(backend): extract semantic search to SemanticRepository"
```

---

## Task 5: Extract `TagRepository.ts`

Methods to move:
- `fetchTags()` (line 331)
- `preAggregateJSON()` (line 381)
- `createTag()` (line 1099)
- `saveTag()` (line 1232)
- `upsertTag()` (line 1237)
- `mergeTags()` (line 1436)
- `removeTags()` (line 1475)

State to move:
- `#isQueryDirty` (line 98) — `preAggregateJSON` sets/reads this; `FileRepository` also needs to trigger it (see Task 6)

**Files:**
- Create: `src/backend/repositories/TagRepository.ts`
- Modify: `src/backend/backend.ts`

- [ ] **Step 1: Create `src/backend/repositories/TagRepository.ts`**

```typescript
import { Kysely, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/sqlite';
import { AllusionDB_SQL, serializeBoolean, deserializeBoolean, serializeDate, deserializeDate, SubTags, TagAliases, TagImplications } from '../schemaTypes';
import { TagDTO, ROOT_TAG_ID } from 'src/api/tag';
import { ID, generateId } from 'src/api/id';
import { ConditionGroupDTO } from 'src/api/data-storage-search';
import { FileDTO } from 'src/api/file';
import { applyFileFilters } from '../query-builder';

export class TagRepository {
  #db: Kysely<AllusionDB_SQL>;
  /** True when file_tag_aggregates_temp needs recomputation */
  isQueryDirty = true;

  constructor(db: Kysely<AllusionDB_SQL>) {
    this.#db = db;
  }

  // [paste fetchTags, preAggregateJSON, createTag, saveTag, upsertTag, mergeTags, removeTags here]
  // In preAggregateJSON, replace `this.#isQueryDirty` with `this.isQueryDirty`
}
```

Note: `isQueryDirty` is made `public` (no `#`) so `FileRepository` can set it to `true` after writes.

- [ ] **Step 2: Move the method bodies**

Cut the 7 methods from `backend.ts` and paste inside `TagRepository`. Replace all `this.#isQueryDirty` references with `this.isQueryDirty`.

- [ ] **Step 3: Delegate from `Backend`**

```typescript
import { TagRepository } from './repositories/TagRepository';

export default class Backend implements DataStorage {
  #tags!: TagRepository;

  async init(...) {
    // ...
    this.#tags = new TagRepository(this.#db);
  }

  async fetchTags(): Promise<TagDTO[]> { return this.#tags.fetchTags(); }
  async createTag(tag: TagDTO): Promise<void> { return this.#tags.createTag(tag); }
  async saveTag(tag: TagDTO): Promise<void> { return this.#tags.saveTag(tag); }
  async upsertTag(tag: TagDTO): Promise<void> { return this.#tags.upsertTag(tag); }
  async mergeTags(tagToBeRemoved: ID, tagToMergeWith: ID): Promise<void> {
    return this.#tags.mergeTags(tagToBeRemoved, tagToMergeWith);
  }
  async removeTags(tags: ID[]): Promise<void> { return this.#tags.removeTags(tags); }
  async preAggregateJSON(): Promise<void> { return this.#tags.preAggregateJSON(); }
  async setSeed(seed?: number): Promise<void> {
    this.#seed = seed ?? generateSeed();
  }
}
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/backend/repositories/TagRepository.ts src/backend/backend.ts
git commit -m "refactor(backend): extract tag operations to TagRepository"
```

---

## Task 6: Extract `LocationRepository.ts`, `SearchRepository.ts`, `ExtraPropertyRepository.ts`

These three are small enough to tackle together. They have no shared state and their methods are straightforward CRUD.

**LocationRepository methods:**
- `fetchLocations()` (line 925)
- `createLocation()` (line 1217)
- `saveLocation()` (line 1365)
- `upsertLocation()` (line 1370)
- `removeLocation()` (line 1489)

**SearchRepository methods:**
- `fetchSearches()` (line 993)
- `createSearch()` (line 1222)
- `saveSearch()` (line 1394)
- `upsertSearch()` (line 1399)
- `removeSearch()` (line 1498)

**ExtraPropertyRepository methods:**
- `fetchExtraProperties()` (line 1084)
- `createExtraProperty()` (line 1227)
- `saveExtraProperty()` (line 1418)
- `upsertExtraProperty()` (line 1423)
- `removeExtraProperties()` (line 1505)

**Files:**
- Create: `src/backend/repositories/LocationRepository.ts`
- Create: `src/backend/repositories/SearchRepository.ts`
- Create: `src/backend/repositories/ExtraPropertyRepository.ts`
- Modify: `src/backend/backend.ts`

- [ ] **Step 1: Create `src/backend/repositories/LocationRepository.ts`**

```typescript
import { Kysely } from 'kysely';
import { AllusionDB_SQL, serializeBoolean, deserializeBoolean, Locations, LocationNodes, LocationTags, SubLocations } from '../schemaTypes';
import { LocationDTO, SubLocationDTO } from 'src/api/location';
import { ID, generateId } from 'src/api/id';
import { UpdateObject } from 'kysely/dist/cjs/parser/update-set-parser';

export class LocationRepository {
  #db: Kysely<AllusionDB_SQL>;

  constructor(db: Kysely<AllusionDB_SQL>) {
    this.#db = db;
  }

  // [paste fetchLocations, createLocation, saveLocation, upsertLocation, removeLocation here]
}
```

- [ ] **Step 2: Create `src/backend/repositories/SearchRepository.ts`**

```typescript
import { Kysely } from 'kysely';
import { AllusionDB_SQL, serializeBoolean, SavedSearches, SearchCriteria, SearchGroups } from '../schemaTypes';
import { FileSearchDTO, SearchGroupDTO } from 'src/api/file-search';
import { ID, generateId } from 'src/api/id';

export class SearchRepository {
  #db: Kysely<AllusionDB_SQL>;

  constructor(db: Kysely<AllusionDB_SQL>) {
    this.#db = db;
  }

  // [paste fetchSearches, createSearch, saveSearch, upsertSearch, removeSearch here]
}
```

- [ ] **Step 3: Create `src/backend/repositories/ExtraPropertyRepository.ts`**

```typescript
import { Kysely } from 'kysely';
import { AllusionDB_SQL, DbExtraProperties as DbExtraProps } from '../schemaTypes';
import { ExtraPropertyDTO } from 'src/api/extraProperty';
import { ID, generateId } from 'src/api/id';

export class ExtraPropertyRepository {
  #db: Kysely<AllusionDB_SQL>;

  constructor(db: Kysely<AllusionDB_SQL>) {
    this.#db = db;
  }

  // [paste fetchExtraProperties, createExtraProperty, saveExtraProperty, upsertExtraProperty, removeExtraProperties here]
}
```

- [ ] **Step 4: Move the method bodies**

Cut all 14 methods from `backend.ts` and paste into their respective repository classes.

- [ ] **Step 5: Delegate from `Backend`**

```typescript
import { LocationRepository } from './repositories/LocationRepository';
import { SearchRepository } from './repositories/SearchRepository';
import { ExtraPropertyRepository } from './repositories/ExtraPropertyRepository';

export default class Backend implements DataStorage {
  #locations!: LocationRepository;
  #searches!: SearchRepository;
  #extraProperties!: ExtraPropertyRepository;

  async init(...) {
    // ...
    this.#locations = new LocationRepository(this.#db);
    this.#searches = new SearchRepository(this.#db);
    this.#extraProperties = new ExtraPropertyRepository(this.#db);
  }

  async fetchLocations(): Promise<LocationDTO[]> { return this.#locations.fetchLocations(); }
  async createLocation(location: LocationDTO): Promise<void> { return this.#locations.createLocation(location); }
  async saveLocation(location: LocationDTO): Promise<void> { return this.#locations.saveLocation(location); }
  async upsertLocation(location: LocationDTO): Promise<void> { return this.#locations.upsertLocation(location); }
  async removeLocation(location: ID): Promise<void> { return this.#locations.removeLocation(location); }

  async fetchSearches(): Promise<FileSearchDTO[]> { return this.#searches.fetchSearches(); }
  async createSearch(search: FileSearchDTO): Promise<void> { return this.#searches.createSearch(search); }
  async saveSearch(search: FileSearchDTO): Promise<void> { return this.#searches.saveSearch(search); }
  async upsertSearch(search: FileSearchDTO): Promise<void> { return this.#searches.upsertSearch(search); }
  async removeSearch(search: ID): Promise<void> { return this.#searches.removeSearch(search); }

  async fetchExtraProperties(): Promise<ExtraPropertyDTO[]> { return this.#extraProperties.fetchExtraProperties(); }
  async createExtraProperty(ep: ExtraPropertyDTO): Promise<void> { return this.#extraProperties.createExtraProperty(ep); }
  async saveExtraProperty(ep: ExtraPropertyDTO): Promise<void> { return this.#extraProperties.saveExtraProperty(ep); }
  async upsertExtraProperty(ep: ExtraPropertyDTO): Promise<void> { return this.#extraProperties.upsertExtraProperty(ep); }
  async removeExtraProperties(ids: ID[]): Promise<void> { return this.#extraProperties.removeExtraProperties(ids); }
}
```

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/backend/repositories/LocationRepository.ts src/backend/repositories/SearchRepository.ts src/backend/repositories/ExtraPropertyRepository.ts src/backend/backend.ts
git commit -m "refactor(backend): extract location, search, and extra property repositories"
```

---

## Task 7: Extract `FileRepository.ts`

This is the last and largest extraction from `backend.ts`. Remaining methods after previous tasks:
- `fetchFiles()` (line 460)
- `searchFiles()` (line 481)
- `fetchFilesByID()` (line 904)
- `fetchFilesByKey()` (line 911)
- `queryFiles()` (line 422)
- `createFilesFromPath()` (line 1105)
- `saveFiles()` (line 1260)
- `removeFiles()` (line 1482)
- `addTagsToFiles()` (line 1512)
- `removeTagsFromFiles()` (line 1538)
- `clearTagsFromFiles()` (line 1553)
- `countFiles()` (line 1562)
- `compareFiles()` (line 1591)
- `findMissingDBMatches()` (line 1681)
- `clear()` (line 1794)
- `setSeed()` (line 327)

Private helpers:
- `mapToDTO()` top-level function (line 1840) — can be a module-private function in FileRepository.ts
- `isValidCursor()` (line 1892) — also module-private
- `computeSampleTimestamps()` (line 1979), `meanPoolEmbeddings()` (line 1991) — used by SemanticRepository, move there if not already moved

State to move to FileRepository:
- `#seed` (line 100) — used in `queryFiles` for random ordering
- `MAX_VARS` (line 91) — used in batch operations

FileRepository also needs to mark `TagRepository.isQueryDirty = true` after writes. Pass the `TagRepository` instance into `FileRepository` in its constructor.

**Files:**
- Create: `src/backend/repositories/FileRepository.ts`
- Modify: `src/backend/backend.ts`

- [ ] **Step 1: Create `src/backend/repositories/FileRepository.ts`**

```typescript
import { Kysely, sql, SelectQueryBuilder } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/sqlite';
import { AllusionDB_SQL, serializeBoolean, deserializeBoolean, serializeDate, Files, FileTags, EpValues } from '../schemaTypes';
import { FileDTO, FileStats } from 'src/api/file';
import { ID, generateId } from 'src/api/id';
import { LocationDTO } from 'src/api/location';
import {
  OrderBy, OrderDirection, ConditionGroupDTO, PaginationDirection, Cursor, IndexableType,
} from 'src/api/data-storage-search';
import { ExtraProperties } from 'src/api/extraProperty';
import { isRenderable3DModelPath } from 'src/rendering/ModelPreviewRenderer';
import { isFileExtensionVideo } from 'common/fs';
import {
  getOrderColumnExpression, ConditionWithConjunction, applyFileFilters, applyPagination,
} from '../query-builder';
import { getSqliteMaxVariables, computeBatchSize, generateSeed } from '../db';
import type { TagRepository } from './TagRepository';
import type { SemanticRepository } from './SemanticRepository';

export class FileRepository {
  readonly #db: Kysely<AllusionDB_SQL>;
  readonly #tagRepo: TagRepository;
  readonly #semanticRepo: SemanticRepository;
  #seed: number;
  MAX_VARS!: number;

  constructor(
    db: Kysely<AllusionDB_SQL>,
    tagRepo: TagRepository,
    semanticRepo: SemanticRepository,
    seed: number,
  ) {
    this.#db = db;
    this.#tagRepo = tagRepo;
    this.#semanticRepo = semanticRepo;
    this.#seed = seed;
  }

  // [paste all listed methods here]
  // Replace this.#isQueryDirty = true  →  this.#tagRepo.isQueryDirty = true
  // Replace this.#seed                 →  this.#seed
  // Replace this.#semanticEmbeddingDimension / enqueueSemanticEmbeddings → this.#semanticRepo.*
}

function mapToDTO(dbFile: FileDTO | { [x: string]: any }): FileDTO {
  // [move mapToDTO here verbatim]
}

function isValidCursor(cursor: any): cursor is Cursor {
  // [move isValidCursor here verbatim]
}
```

- [ ] **Step 2: Move the method bodies**

Cut all listed methods from `backend.ts` and paste into `FileRepository`. Apply the replacements described in the constructor comment above.

In `createFilesFromPath`, find the call to `this.enqueueSemanticEmbeddings(fileIds)` and change to `this.#semanticRepo.enqueueSemanticEmbeddings(fileIds)`.

- [ ] **Step 3: Delegate from `Backend`**

After this task, `backend.ts` should be just the coordinator. Replace all removed methods with delegation:

```typescript
import { FileRepository } from './repositories/FileRepository';

export default class Backend implements DataStorage {
  #db!: Kysely<AllusionDB_SQL>;
  #sqlite!: SQLite.Database;
  #dbPath!: string;
  #notifyChange!: () => void;
  #restoreEmpty!: () => Promise<void>;
  #tags!: TagRepository;
  #files!: FileRepository;
  #locations!: LocationRepository;
  #searches!: SearchRepository;
  #extraProperties!: ExtraPropertyRepository;
  #semantic!: SemanticRepository;

  constructor() {
    return USE_TIMING_PROXY ? createTimingProxy(this) : this;
  }

  async init(dbPath, mode, notifyChange, restoreEmpty, jsonToImport) {
    this.#notifyChange = notifyChange;
    this.#restoreEmpty = restoreEmpty;
    const { db, sqlite } = await initDB(dbPath, mode, jsonToImport);
    this.#db = db;
    this.#sqlite = sqlite;
    this.#dbPath = dbPath;
    this.MAX_VARS = await getSqliteMaxVariables(db);

    this.#tags = new TagRepository(db);
    this.#semantic = new SemanticRepository(db, sqlite);
    this.#locations = new LocationRepository(db);
    this.#searches = new SearchRepository(db);
    this.#extraProperties = new ExtraPropertyRepository(db);
    this.#files = new FileRepository(db, this.#tags, this.#semantic, generateSeed());
    this.#files.MAX_VARS = this.MAX_VARS;

    if (mode === 'default' || mode === 'migrate') {
      await migrateToLatest(db, { jsonToImport });
    }
    if (mode === 'migrate' || mode === 'readonly') {
      return this;
    }

    await this.#tags.preAggregateJSON();
    return this;
  }

  // --- Delegation ---
  async setSeed(seed?: number) { return this.#files.setSeed(seed); }
  async fetchFiles(...args) { return this.#files.fetchFiles(...args); }
  async searchFiles(...args) { return this.#files.searchFiles(...args); }
  async fetchFilesByID(ids) { return this.#files.fetchFilesByID(ids); }
  async fetchFilesByKey(key, values) { return this.#files.fetchFilesByKey(key, values); }
  async createFilesFromPath(path, filesDTO) { return this.#files.createFilesFromPath(path, filesDTO); }
  async saveFiles(filesDTO) { return this.#files.saveFiles(filesDTO); }
  async removeFiles(files) { return this.#files.removeFiles(files); }
  async addTagsToFiles(tagIds, criteria) { return this.#files.addTagsToFiles(tagIds, criteria); }
  async removeTagsFromFiles(tagIds, criteria) { return this.#files.removeTagsFromFiles(tagIds, criteria); }
  async clearTagsFromFiles(criteria) { return this.#files.clearTagsFromFiles(criteria); }
  async countFiles(criteria) { return this.#files.countFiles(criteria); }
  async compareFiles(...args) { return this.#files.compareFiles(...args); }
  async findMissingDBMatches(...args) { return this.#files.findMissingDBMatches(...args); }
  async clear() { return this.#files.clear(); }
  async preAggregateJSON() { return this.#tags.preAggregateJSON(); }
  // ... all other delegations already added in previous tasks
}
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Run tests**

```bash
yarn test
```
Expected: `Tests: 25 passed, 25 total`

- [ ] **Step 6: Confirm backend.ts is under 500 lines**

```bash
wc -l src/backend/backend.ts
```
Expected: under 500.

- [ ] **Step 7: Commit**

```bash
git add src/backend/repositories/FileRepository.ts src/backend/backend.ts
git commit -m "refactor(backend): extract file operations to FileRepository, backend.ts is now coordinator only"
```

---

## Task 8: Split `src/main.ts` into `src/main/` modules

`main.ts` is 906 lines mixing window lifecycle, menu building, auto-updater, preferences I/O, and IPC handler registration.

**What goes where:**
- `src/main/window.ts` — `createWindow()` (line 105), `createPreviewWindow()` (line 365), `createTrayMenu()` (line 408), `getMainWindowDisplay()` (line 796), `getPreviousWindowState()` (line 808), `saveWindowState()` (line 852), `forceRelaunch()` (line 868), `getVersion()` (line 873). Also the `mainWindow` and `previewWindow` module-level variables.
- `src/main/updater.ts` — all `autoUpdater.on(...)` handlers (lines 490–571), `checkForUpdates()` helper if extracted
- `src/main/preferences.ts` — `getPreferences()`, `updatePreferences()`, the `preferences` variable and its type, reading/writing the JSON file (lines 780–795 region)
- `src/main/ipc-handlers.ts` — all `MainMessenger.on*(...)` calls (lines 617–787)

**Files:**
- Create: `src/main/window.ts`, `src/main/updater.ts`, `src/main/preferences.ts`, `src/main/ipc-handlers.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Create `src/main/preferences.ts`**

```typescript
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

interface Preferences {
  checkForUpdatesOnStartup?: boolean;
  // add other preference fields as you find them while reading main.ts
}

const preferencesPath = path.join(app.getPath('userData'), 'preferences.json');

let preferences: Preferences = {};

export function loadPreferences(): Preferences {
  try {
    const raw = fs.readFileSync(preferencesPath, 'utf-8');
    preferences = JSON.parse(raw);
  } catch {
    preferences = {};
  }
  return preferences;
}

export function getPreferences(): Preferences {
  return preferences;
}

export function updatePreferences(update: Partial<Preferences>): void {
  preferences = { ...preferences, ...update };
  fs.writeFileSync(preferencesPath, JSON.stringify(preferences, null, 2));
}
```

Move the actual preference reading/writing code verbatim from `main.ts` — the skeleton above matches the pattern; fill in actual field names and logic from the file.

- [ ] **Step 2: Create `src/main/updater.ts`**

```typescript
import { autoUpdater, BrowserWindow } from 'electron';
import type { UpdateInfo } from 'electron-updater';
import { MainMessenger } from 'src/ipc/renderer';
import { getPreferences, updatePreferences } from './preferences';

export function setupUpdater(getMainWindow: () => BrowserWindow | null): void {
  autoUpdater.on('error', (error) => {
    // [move the autoUpdater.on('error') handler body verbatim]
  });

  autoUpdater.on('update-available', async (info: UpdateInfo) => {
    // [move verbatim]
  });

  autoUpdater.on('update-not-available', () => {
    // [move verbatim]
  });

  autoUpdater.on('update-downloaded', async () => {
    // [move verbatim]
  });

  autoUpdater.on('download-progress', (progressObj: { percent: number }) => {
    // [move verbatim]
  });
}
```

- [ ] **Step 3: Create `src/main/window.ts`**

```typescript
import { BrowserWindow, screen, shell, app } from 'electron';
import path from 'node:path';
import { MainMessenger } from 'src/ipc/renderer';
import { getPreferences, updatePreferences } from './preferences';

export let mainWindow: BrowserWindow | null = null;
export let previewWindow: BrowserWindow | null = null;

export function createWindow(): void {
  // [move createWindow body verbatim]
}

export function createPreviewWindow(): void {
  // [move createPreviewWindow body verbatim]
}

export function createTrayMenu(): void {
  // [move createTrayMenu body verbatim]
}

export function getMainWindowDisplay(): Electron.Display {
  // [move verbatim]
}

export function getPreviousWindowState(): Electron.Rectangle & { isMaximized?: boolean } {
  // [move verbatim]
}

export function saveWindowState(): void {
  // [move verbatim]
}

export function forceRelaunch(): void {
  // [move verbatim]
}

export function getVersion(): string {
  // [move verbatim]
}
```

- [ ] **Step 4: Create `src/main/ipc-handlers.ts`**

```typescript
import { app, dialog, shell, nativeTheme } from 'electron';
import { MainMessenger } from 'src/ipc/renderer';
import {
  mainWindow, previewWindow, createPreviewWindow, forceRelaunch, getVersion,
} from './window';
import { getPreferences, updatePreferences } from './preferences';
import { autoUpdater } from 'electron-updater';
import type { ClipServer } from 'src/clipper/clipServer';

export function registerIpcHandlers(getClipServer: () => ClipServer | undefined): void {
  // [move all MainMessenger.on*(...) calls from main.ts verbatim into this function]
}
```

- [ ] **Step 5: Rewrite `src/main.ts` as thin entry point**

```typescript
import { app } from 'electron';
import { loadPreferences } from './main/preferences';
import { createWindow, mainWindow } from './main/window';
import { setupUpdater } from './main/updater';
import { registerIpcHandlers } from './main/ipc-handlers';
import { initialize } from './main/initialize'; // if there's an initialize() fn worth keeping

function bootstrap(): void {
  loadPreferences();
  setupUpdater(() => mainWindow);
  registerIpcHandlers(() => clipServer);
}

app.whenReady().then(() => {
  bootstrap();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
```

Keep only the `app.on(...)` lifecycle wiring in `main.ts`. Move everything else.

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/main.ts src/main/window.ts src/main/updater.ts src/main/preferences.ts src/main/ipc-handlers.ts
git commit -m "refactor(main): split main.ts into window, updater, preferences, and ipc-handlers modules"
```

---

## Task 9: Split `FileStore.ts` into `FileStore/` sub-folder

`FileStore.ts` is 2,252 lines. The class has four logical zones:
1. **Search / fetch** (`fetchFiles`, `fetchFilesByQuery`, `semanticSearch*`, `fetchPage`, `getFetchArgs`, `initialFetch`, pagination methods, order methods ~lines 752–1440)
2. **Selection / clipboard** (`selectFile`, `deselectFile`, `toggleFileSelection`, `selectFileRange`, `selectAllFiles`, `clearFileSelection`, clipboard ops in `UiStore` also touch selection — keep selection helpers here, ~lines 1814–2063)
3. **Operations** (`addTagsToFiles`, `removeTagsFromFiles`, `dispatchToFilteredFiles`, `readTagsFromFiles`, `writeTagsToFiles`, tag-service methods, `deleteFiles`, ~lines 314–593, 2118–2245)
4. **Persistence** (`recoverPersistentPreferences`, `persistPreferences`, `saveFilesToSave`, ~lines 233–256, 1556–1638)

The approach: create the folder, move `FileStore.ts` to `FileStore/index.ts`, then extract pure helper functions (not methods) into sub-modules. Keep all `@observable` / `@action` on the class in `index.ts`.

**Files:**
- Rename: `src/frontend/stores/FileStore.ts` → `src/frontend/stores/FileStore/index.ts`
- Create: `src/frontend/stores/FileStore/search.ts`
- Create: `src/frontend/stores/FileStore/selection.ts`
- Create: `src/frontend/stores/FileStore/operations.ts`

- [ ] **Step 1: Move `FileStore.ts` to a folder**

```bash
mkdir -p src/frontend/stores/FileStore
mv src/frontend/stores/FileStore.ts src/frontend/stores/FileStore/index.ts
```

- [ ] **Step 2: Type-check immediately — no logic change yet**

```bash
npx tsc --noEmit
```

If errors appear, they're likely from other files importing `FileStore` by path. Fix those imports to point to the folder (`stores/FileStore` — TypeScript resolves `index.ts` automatically).

- [ ] **Step 3: Create `src/frontend/stores/FileStore/search.ts`**

Extract the fetch argument builder and pagination helpers as standalone functions. These currently live inside `getFetchArgs()` and `queryFiles()` on the class. Move logic that doesn't touch `this` into this module:

```typescript
import { OrderBy, OrderDirection, PaginationDirection, Cursor, ConditionGroupDTO } from 'src/api/data-storage-search';
import { FileDTO } from 'src/api/file';
import { ClientFile } from 'src/frontend/entities/File';

/** Determines if two cursors are effectively the same position */
export function isSameCursor(a: Cursor | undefined, b: Cursor | undefined): boolean {
  // [extract from getFetchArgs or related logic]
}

/** Builds the sort key for cursor-based pagination */
export function buildCursorKey(file: ClientFile, orderBy: OrderBy<FileDTO>): string | number | Date {
  // [extract from toCursor or related]
}
```

The goal is not to extract the entire method, but to pull out **pure functions** that don't use `this`. These go into `search.ts` and the class methods call them.

- [ ] **Step 4: Create `src/frontend/stores/FileStore/selection.ts`**

```typescript
import { ClientFile } from 'src/frontend/entities/File';
import { ID } from 'src/api/id';

/** Returns a new selection array after toggling a file */
export function toggleFileInSelection(
  selected: ReadonlySet<ID>,
  fileId: ID,
  clear: boolean,
): Set<ID> {
  if (clear) return new Set([fileId]);
  const next = new Set(selected);
  if (next.has(fileId)) next.delete(fileId);
  else next.add(fileId);
  return next;
}

/** Returns indices [start..end] inclusive as a sorted range */
export function buildFileRange(start: number, end: number): number[] {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}
```

Move the equivalent pure logic from `cleanFileSelection`, `selectFileRange`, etc. into these helpers. The `@action` methods in `index.ts` call these functions.

- [ ] **Step 5: Create `src/frontend/stores/FileStore/operations.ts`**

```typescript
import { FileDTO } from 'src/api/file';
import { ClientFile } from 'src/frontend/entities/File';
import { ClientTag } from 'src/frontend/entities/Tag';
import { ID } from 'src/api/id';

/** Returns the set of tag IDs present in all given files (intersection) */
export function intersectTags(files: ClientFile[]): Set<ID> {
  if (files.length === 0) return new Set();
  const [first, ...rest] = files;
  const result = new Set(first.tags.map((t) => t.id));
  for (const file of rest) {
    for (const id of result) {
      if (!file.tags.some((t) => t.id === id)) result.delete(id);
    }
  }
  return result;
}
```

Extract other pure helpers from the tag-reading/writing logic similarly. Heavy async orchestration stays on the class.

- [ ] **Step 6: Import and use in `index.ts`**

In `FileStore/index.ts`, import from the sub-modules and call the extracted functions:
```typescript
import { toggleFileInSelection, buildFileRange } from './selection';
import { intersectTags } from './operations';
```

- [ ] **Step 7: Type-check and test**

```bash
npx tsc --noEmit && yarn test
```
Expected: no errors, 25 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/stores/FileStore/
git commit -m "refactor(FileStore): move to folder, extract pure helpers into sub-modules"
```

---

## Task 10: Split `LocationStore.ts` into `LocationStore/` sub-folder

`LocationStore.ts` is 882 lines. The clearest extraction: the file-lookup cache helpers and watcher coordination.

**Files:**
- Rename: `src/frontend/stores/LocationStore.ts` → `src/frontend/stores/LocationStore/index.ts`
- Create: `src/frontend/stores/LocationStore/watcher.ts`
- Create: `src/frontend/stores/LocationStore/indexer.ts`

- [ ] **Step 1: Move to folder**

```bash
mkdir -p src/frontend/stores/LocationStore
mv src/frontend/stores/LocationStore.ts src/frontend/stores/LocationStore/index.ts
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```
Fix any import path errors.

- [ ] **Step 3: Create `src/frontend/stores/LocationStore/indexer.ts`**

Extract the DB cache helpers as pure functions:

```typescript
import { FileDTO } from 'src/api/file';

export interface CacheEntry<T> {
  value: T | undefined;
  expiresAt: number;
}

export function isCacheValid<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() < entry.expiresAt;
}

export function makeCacheEntry<T>(value: T | undefined, ttlMs: number): CacheEntry<T> {
  return { value, expiresAt: Date.now() + ttlMs };
}
```

These replace the inline `getCachedDbFileByPath` / `getCachedDbFileByIno` logic. The maps themselves (`dbFileByPathCache`, `dbFileByInoCache`) stay on the store class.

- [ ] **Step 4: Create `src/frontend/stores/LocationStore/watcher.ts`**

```typescript
import type { ClientLocation } from 'src/frontend/entities/Location';

/** Returns true if the watcher for this location should be restarted */
export function shouldRestartWatcher(
  location: ClientLocation,
  previousPath: string,
): boolean {
  return location.path !== previousPath;
}
```

Extract any other pure logic from `watchLocations` / `updateLocations` that doesn't need `this`. The async orchestration stays on the class.

- [ ] **Step 5: Import sub-modules in `index.ts`**

```typescript
import { isCacheValid, makeCacheEntry } from './indexer';
import { shouldRestartWatcher } from './watcher';
```

- [ ] **Step 6: Type-check and test**

```bash
npx tsc --noEmit && yarn test
```

- [ ] **Step 7: Commit**

```bash
git add src/frontend/stores/LocationStore/
git commit -m "refactor(LocationStore): move to folder, extract cache and watcher helpers"
```

---

## Task 11: Split `UiStore.ts` into `UiStore/` sub-folder

`UiStore.ts` is 1,672 lines. Extract three clusters of pure helpers:
- **theme.ts** — thumbnail/theme setting helpers
- **preferences.ts** — serialize/deserialize persistent preferences
- **hotkeys.ts** — hotkey map type and default map

**Files:**
- Rename: `src/frontend/stores/UiStore.ts` → `src/frontend/stores/UiStore/index.ts`
- Create: `src/frontend/stores/UiStore/theme.ts`
- Create: `src/frontend/stores/UiStore/preferences.ts`
- Create: `src/frontend/stores/UiStore/hotkeys.ts`

- [ ] **Step 1: Move to folder**

```bash
mkdir -p src/frontend/stores/UiStore
mv src/frontend/stores/UiStore.ts src/frontend/stores/UiStore/index.ts
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Create `src/frontend/stores/UiStore/hotkeys.ts`**

Locate `IHotkeyMap` interface and the default hotkey map constant in `UiStore.ts` (around the `remapHotkey` / `processGlobalShortCuts` methods). Move them:

```typescript
export interface IHotkeyMap {
  // [copy the interface definition verbatim]
}

export const DEFAULT_HOTKEYS: IHotkeyMap = {
  // [copy the default hotkey map object verbatim]
};
```

In `UiStore/index.ts`:
```typescript
import { IHotkeyMap, DEFAULT_HOTKEYS } from './hotkeys';
```

- [ ] **Step 4: Create `src/frontend/stores/UiStore/preferences.ts`**

Locate the preferences serialization/deserialization logic in `recoverPersistentPreferences()` and `persistPreferences()`. Extract the pure data-mapping parts:

```typescript
import { ThumbnailSize, ThumbnailShape, ViewMethod, Theme } from '../UiStore/index';
// (adjust imports based on where enums live)

export interface PersistedUiPrefs {
  thumbnailSize?: ThumbnailSize;
  thumbnailShape?: ThumbnailShape;
  method?: ViewMethod;
  theme?: Theme;
  // [add all fields serialized in recoverPersistentPreferences]
}

export function serializePrefs(/* store fields */): PersistedUiPrefs {
  // [extract the serialization logic]
}

export function deserializePrefs(raw: unknown): Partial<PersistedUiPrefs> {
  // [extract the deserialization/validation logic]
}
```

- [ ] **Step 5: Create `src/frontend/stores/UiStore/theme.ts`**

Extract the thumbnail-size clamping helper:

```typescript
import { ThumbnailSize, THUMBNAIL_SIZES } from '../UiStore/index';

export function clampThumbnailSize(size: number): ThumbnailSize {
  // [extract from setThumbnailSize logic if there's clamping/rounding]
}
```

- [ ] **Step 6: Import sub-modules in `index.ts`**

```typescript
import { IHotkeyMap, DEFAULT_HOTKEYS } from './hotkeys';
import { serializePrefs, deserializePrefs } from './preferences';
```

- [ ] **Step 7: Type-check and test**

```bash
npx tsc --noEmit && yarn test
```

- [ ] **Step 8: Commit**

```bash
git add src/frontend/stores/UiStore/
git commit -m "refactor(UiStore): move to folder, extract hotkeys, preferences, and theme helpers"
```

---

## Task 12: Split `TagsTree.tsx` into `TagsTree/` sub-folder

`TagsTree.tsx` lives at `src/frontend/containers/Outliner/TagsPanel/TagsTree.tsx` (877 lines). The natural seams:
- `TagItem` component (~line 137) — single tag row with label, icon, color dot
- `DnDHelper` and drag-drop logic — currently created at module level with `createDragReorderHelper`
- Context menu logic — distributed across `TagItem` and the main `TagsTree` component
- `TagsTree` main component (~line 565) — layout, splits, search box

**Files:**
- Rename: `.../TagsPanel/TagsTree.tsx` → `.../TagsPanel/TagsTree/index.tsx`
- Create: `.../TagsPanel/TagsTree/TagItem.tsx`
- Create: `.../TagsPanel/TagsTree/DragDrop.ts`
- Create: `.../TagsPanel/TagsTree/ContextMenu.tsx`

- [ ] **Step 1: Move to folder**

```bash
mkdir -p src/frontend/containers/Outliner/TagsPanel/TagsTree
mv src/frontend/containers/Outliner/TagsPanel/TagsTree.tsx \
   src/frontend/containers/Outliner/TagsPanel/TagsTree/index.tsx
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Check for any import of `TagsTree` by the old path and update if needed.

- [ ] **Step 3: Create `DragDrop.ts`**

Move the `DnDHelper` creation and any drag-drop–specific helpers:

```typescript
import { createDragReorderHelper } from 'src/frontend/contexts/DragDropContext'; // adjust actual import
import { DnDTagType } from 'src/frontend/contexts/TagDnDContext'; // adjust

export const DnDHelper = createDragReorderHelper('tag-dnd-preview', DnDTagType);

// [move any other drag-drop helper functions here]
```

In `index.tsx`: `import { DnDHelper } from './DragDrop';`

- [ ] **Step 4: Create `ContextMenu.tsx`**

Identify the context menu rendering logic (right-click handlers, context menu components). Move them:

```typescript
import React from 'react';
import { observer } from 'mobx-react-lite';
import { ClientTag } from 'src/frontend/entities/Tag';
import { useStore } from 'src/frontend/contexts/StoreContext';

interface TagContextMenuProps {
  tag: ClientTag;
  onClose: () => void;
}

export const TagContextMenu = observer(({ tag, onClose }: TagContextMenuProps) => {
  const { uiStore } = useStore();
  // [move context menu JSX here]
  return (/* ... */);
});
```

- [ ] **Step 5: Create `TagItem.tsx`**

Move the `TagItem` observer component (~line 137–348 in original file):

```typescript
import React from 'react';
import { observer } from 'mobx-react-lite';
import { ClientTag } from 'src/frontend/entities/Tag';
import { UiStore } from 'src/frontend/stores/UiStore';
import { DnDHelper } from './DragDrop';

interface ITagItemProps {
  // [copy ITagItemProps interface verbatim]
}

export const TagItem = observer((props: ITagItemProps) => {
  // [move TagItem body verbatim]
});
```

- [ ] **Step 6: Update `index.tsx` imports**

```typescript
import { TagItem } from './TagItem';
import { DnDHelper } from './DragDrop';
import { TagContextMenu } from './ContextMenu';
```

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add src/frontend/containers/Outliner/TagsPanel/TagsTree/
git commit -m "refactor(TagsTree): split into TagItem, DragDrop, and ContextMenu sub-modules"
```

---

## Task 13: Split `FileExtraPropertiesEditor.tsx` into sub-folder

`FileExtraPropertiesEditor.tsx` is 812 lines. Natural seams based on what's already in the file:
- `ExtraPropertyContextMenu` (~line 309) — right-click menu for a property
- `ExtraPropertyListEditor` (~line 424) — editor for list-type properties
- `ExtraPropertyInput` (~line 592) — the generic input for a single property value
- `Label` (~line 726) + `reducer` (~line 791) — editing label state machine
- `FileExtraPropertiesEditor` (main, ~line 40) — stays in `index.tsx`

**Files:**
- Rename: `.../FileExtraPropertiesEditor.tsx` → `.../FileExtraPropertiesEditor/index.tsx`
- Create: `.../FileExtraPropertiesEditor/PropertyField.tsx`
- Create: `.../FileExtraPropertiesEditor/PropertyForm.tsx`

- [ ] **Step 1: Move to folder**

```bash
mkdir -p src/frontend/components/FileExtraPropertiesEditor
mv src/frontend/components/FileExtraPropertiesEditor.tsx \
   src/frontend/components/FileExtraPropertiesEditor/index.tsx
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Create `PropertyField.tsx`**

Move `ExtraPropertyInput`, `Label`, `reducer`, `Flag`, `Action`, `State`, `Factory` (the editing state machine and input rendering):

```typescript
import React, { useReducer } from 'react';
import { observer } from 'mobx-react-lite';
import { ExtraPropertyDTO, ExtraPropertyValue } from 'src/api/extraProperty';
import { ClientExtraProperty } from 'src/frontend/entities/ExtraProperty';

// [move Flag enum, Action type, State type, Factory, reducer verbatim]

interface ExtraPropertyInputProps {
  // [copy verbatim]
}

export const ExtraPropertyInput = ({ ... }: ExtraPropertyInputProps) => {
  // [move verbatim]
};

// [move Label component verbatim]
export const Label = ...;
```

- [ ] **Step 4: Create `PropertyForm.tsx`**

Move `ExtraPropertyContextMenu`, `ExtraPropertyListEditor`, `ExtraPropertyListOption`, `typeHandlers`, `PortalButtonWrapper`:

```typescript
import React from 'react';
import { observer } from 'mobx-react-lite';
// [add remaining imports as needed]

export const ExtraPropertyContextMenu = ({ ... }) => {
  // [move verbatim]
};

export const ExtraPropertyListEditor = observer(({ ... }) => {
  // [move verbatim]
});

// [move remaining components verbatim]
```

- [ ] **Step 5: Update `index.tsx` imports**

```typescript
import { ExtraPropertyInput, Label } from './PropertyField';
import { ExtraPropertyContextMenu, ExtraPropertyListEditor } from './PropertyForm';
```

- [ ] **Step 6: Type-check and test**

```bash
npx tsc --noEmit && yarn test
```
Expected: no errors, 25 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/components/FileExtraPropertiesEditor/
git commit -m "refactor(FileExtraPropertiesEditor): split into PropertyField and PropertyForm sub-modules"
```

---

## Task 14: Final verification and size audit

- [ ] **Step 1: Run full test suite**

```bash
yarn test
```
Expected: `Tests: 25 passed, 25 total`

- [ ] **Step 2: Run type-check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Run linter**

```bash
yarn lint
```
Expected: no new errors (fix any auto-fixable issues).

- [ ] **Step 4: Audit file sizes**

```bash
find src -name "*.ts" -o -name "*.tsx" | xargs wc -l | sort -rn | head -20
```

Confirm that no new file significantly exceeds 500 lines. Note any remaining large files.

- [ ] **Step 5: Commit lint fixes if any**

```bash
git add -p
git commit -m "chore: fix lint warnings after refactor"
```

---

## Remaining large files (follow-up, not in this plan)

These are over 500 lines and should be split in follow-up work:
- `src/frontend/components/FileTagsEditor.tsx` (660 lines)
- `src/frontend/containers/HelpCenter.tsx` (659 lines)
- `src/frontend/containers/Outliner/LocationsPanel/index.tsx` (634 lines)
- `src/frontend/components/TagSelector.tsx` (626 lines)
