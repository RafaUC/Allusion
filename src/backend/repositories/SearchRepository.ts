import { Insertable, Kysely } from 'kysely';
import { AllusionDB_SQL, SavedSearches, SearchCriteria, SearchGroups } from '../schemaTypes';
import { FileSearchDTO, SearchGroupDTO } from 'src/api/file-search';
import { ID } from 'src/api/id';
import { upsertTable } from '../backend';

export class SearchRepository {
  readonly #db: Kysely<AllusionDB_SQL>;
  readonly #maxVars: number;
  readonly #notifyChange: () => void;

  constructor(db: Kysely<AllusionDB_SQL>, maxVars: number, notifyChange: () => void) {
    this.#db = db;
    this.#maxVars = maxVars;
    this.#notifyChange = notifyChange;
  }

  async fetchSearches(): Promise<FileSearchDTO[]> {
    console.info('SQLite: Fetching saved searches...');
    const groupsMap = new Map<ID, SearchGroupDTO & { parentGroupId: ID | null }>();
    // 1. Fetch searches
    const savedSearches = await this.#db.selectFrom('savedSearches').selectAll().execute();
    if (!savedSearches.length) {
      return [];
    }
    const savedSearchIds = savedSearches.map((s) => s.id);

    // 2. Fetch groups
    const dbGroups = await this.#db
      .selectFrom('searchGroups')
      .select(['id', 'name', 'savedSearchId', 'parentGroupId', 'idx', 'conjunction'])
      .where('savedSearchId', 'in', savedSearchIds)
      .orderBy('savedSearchId')
      .orderBy('parentGroupId')
      .orderBy('idx')
      .execute();

    for (const grp of dbGroups) {
      groupsMap.set(grp.id, {
        id: grp.id,
        name: grp.name,
        conjunction: grp.conjunction,
        children: [],
        parentGroupId: grp.parentGroupId,
      });
    }

    // 3. Fetch criteria
    const dbCriteria = await this.#db
      .selectFrom('searchCriteria')
      .select(['id', 'groupId', 'idx', 'key', 'valueType', 'operator', 'jsonValue'])
      .where('groupId', 'in', Array.from(groupsMap.keys()))
      .orderBy('groupId')
      .orderBy('idx')
      .execute();

    // 4. Attach criteria to their groups
    for (const crit of dbCriteria) {
      const parent = groupsMap.get(crit.groupId);
      if (!parent) {
        continue;
      }

      parent.children.push({
        id: crit.id,
        key: crit.key,
        operator: crit.operator,
        valueType: crit.valueType,
        value:
          // the ParseJSONResultsPlugin already parses the arrays but not strings
          crit.valueType === 'string' ? JSON.parse(crit.jsonValue as string) : crit.jsonValue,
      });
    }

    // Attach child groups to their parents
    const rootGroupsBySearch = new Map<ID, SearchGroupDTO>();

    for (const [groupId, group] of groupsMap) {
      if (group.parentGroupId) {
        const parent = groupsMap.get(group.parentGroupId);
        if (parent) {
          parent.children.push(group);
        }
      } else {
        // Root group
        const dbGroup = dbGroups.find((g) => g.id === groupId);
        if (dbGroup) {
          rootGroupsBySearch.set(dbGroup.savedSearchId, group);
        }
      }
    }

    // 6. Build final DTOs
    const searches: FileSearchDTO[] = savedSearches.map((search) => ({
      id: search.id,
      name: search.name,
      index: search.idx,
      rootGroup: rootGroupsBySearch.get(search.id) ?? {
        id: 'root-' + search.id,
        name: 'root-' + search.name,
        conjunction: 'and',
        children: [],
      },
    }));

    return searches;
  }

  async createSearch(search: FileSearchDTO): Promise<void> {
    console.info('SQLite: Creating search...', search);
    return this.upsertSearch(search);
  }

  async saveSearch(search: FileSearchDTO): Promise<void> {
    console.info('SQLite: Saving search...', search);
    return this.upsertSearch(search);
  }

  async upsertSearch(search: FileSearchDTO): Promise<void> {
    const { savedSearchesIds, savedSearches, searchGroups, searchCriteria } =
      normalizeSavedSearches([search]);
    if (savedSearches.length === 0) {
      return;
    }
    await this.#db.transaction().execute(async (trx) => {
      await trx.deleteFrom('searchGroups').where('savedSearchId', 'in', savedSearchesIds).execute();
      await upsertTable(this.#maxVars, trx, 'savedSearches', savedSearches, ['id']);
      if (searchGroups.length > 0) {
        await upsertTable(this.#maxVars, trx, 'searchGroups', searchGroups, ['id']);
      }
      if (searchCriteria.length > 0) {
        await upsertTable(this.#maxVars, trx, 'searchCriteria', searchCriteria, ['id']);
      }
    });
    this.#notifyChange();
  }

  async removeSearch(search: ID): Promise<void> {
    console.info('SQLite: Removing search...', search);
    // Cascade delte in other tables deleting from savedSearches table.
    await this.#db.deleteFrom('savedSearches').where('id', '=', search).execute();
    this.#notifyChange();
  }
}

function normalizeSavedSearches(sourceSearches: FileSearchDTO[]) {
  const savedSearchesIds: ID[] = [];
  const savedSearches: Insertable<SavedSearches>[] = [];
  const searchGroups: Insertable<SearchGroups>[] = [];
  const searchCriteria: Insertable<SearchCriteria>[] = [];

  function normalizeGroupRecursive(
    group: SearchGroupDTO,
    savedSearchId: ID,
    parentGroupId: ID | null,
  ) {
    // Insert group
    searchGroups.push({
      id: group.id,
      name: group.name,
      savedSearchId: savedSearchId,
      parentGroupId: parentGroupId,
      idx: 0, // currently this is static, (insertion order)
      conjunction: group.conjunction,
    });
    let idx = 0;
    for (const child of group.children) {
      // if group recurse
      if ('children' in child) {
        normalizeGroupRecursive(child, savedSearchId, group.id);
      }
      // id criteria
      else {
        searchCriteria.push({
          id: child.id,
          groupId: group.id,
          idx: idx++,
          key: child.key,
          valueType: child.valueType,
          operator: child.operator,
          jsonValue: JSON.stringify(child.value),
        });
      }
    }
  }
  for (const search of sourceSearches) {
    savedSearchesIds.push(search.id);
    savedSearches.push({
      id: search.id,
      name: search.name,
      idx: search.index,
    });
    normalizeGroupRecursive(search.rootGroup, search.id, null);
  }
  return {
    savedSearchesIds,
    savedSearches,
    searchGroups,
    searchCriteria,
  };
}
