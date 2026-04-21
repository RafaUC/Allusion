import { Insertable, Kysely, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/sqlite';
import {
  AllusionDB_SQL,
  deserializeBoolean,
  deserializeDate,
  LocationNodes,
  Locations,
  LocationTags,
  serializeBoolean,
  serializeDate,
  SubLocations,
} from '../schemaTypes';
import { LocationDTO, SubLocationDTO } from 'src/api/location';
import { ID } from 'src/api/id';
import { upsertTable } from '../backend';

export class LocationRepository {
  readonly #db: Kysely<AllusionDB_SQL>;
  readonly #maxVars: number;
  readonly #notifyChange: () => void;

  constructor(db: Kysely<AllusionDB_SQL>, maxVars: number, notifyChange: () => void) {
    this.#db = db;
    this.#maxVars = maxVars;
    this.#notifyChange = notifyChange;
  }

  async fetchLocations(): Promise<LocationDTO[]> {
    console.info('SQLite: Fetching locations...');
    /** Map to quicly find a node and his parent <nodeId, nodeInsatnce, parentId>  */
    const locationNodesMap = new Map<ID, [{ subLocations: SubLocationDTO[] }, ID | null]>();
    const locations: LocationDTO[] = (
      await this.#db
        .selectFrom('locations')
        .innerJoin('locationNodes as node', 'node.id', 'locations.nodeId')
        .selectAll()
        .select((eb) => [
          jsonArrayFrom(
            eb
              .selectFrom('locationTags')
              .select('locationTags.tagId')
              .whereRef('locationTags.nodeId', '=', 'locations.nodeId'),
          ).as('tags'),
        ])
        .execute()
    ).map((dbLoc) => {
      // convert data into LocationDTO format
      const lc: LocationDTO = {
        id: dbLoc.id,
        path: dbLoc.path,
        dateAdded: deserializeDate(dbLoc.dateAdded),
        subLocations: [],
        tags: dbLoc.tags.map((t) => t.tagId),
        index: dbLoc.idx,
        isWatchingFiles: deserializeBoolean(dbLoc.isWatchingFiles),
      };
      locationNodesMap.set(dbLoc.id, [lc, dbLoc.parentId]);
      return lc;
    });
    const subLocations: SubLocationDTO[] = (
      await this.#db
        .selectFrom('subLocations')
        .innerJoin('locationNodes as node', 'node.id', 'subLocations.nodeId')
        .selectAll()
        .select((eb) => [
          jsonArrayFrom(
            eb
              .selectFrom('locationTags')
              .select('locationTags.tagId')
              .whereRef('locationTags.nodeId', '=', 'subLocations.nodeId'),
          ).as('tags'),
        ])
        .execute()
    ).map((dbLoc) => {
      // convert data into SubLocationDTO format
      const slc: SubLocationDTO = {
        id: dbLoc.id,
        name: dbLoc.path,
        subLocations: [],
        tags: dbLoc.tags.map((t) => t.tagId),
        isExcluded: deserializeBoolean(dbLoc.isExcluded),
      };
      locationNodesMap.set(dbLoc.id, [slc, dbLoc.parentId]);
      return slc;
    });
    // Insert sublocations into their parents
    for (const subLocation of subLocations) {
      const parent = locationNodesMap.get(locationNodesMap.get(subLocation.id)?.[1] ?? '')?.[0];
      if (parent) {
        parent.subLocations.push(subLocation);
      }
    }
    return locations;
  }

  async createLocation(location: LocationDTO): Promise<void> {
    console.info('SQLite: Creating location...', location);
    return this.upsertLocation(location);
  }

  async saveLocation(location: LocationDTO): Promise<void> {
    console.info('SQLite: Saving location...', location);
    return this.upsertLocation(location);
  }

  async upsertLocation(location: LocationDTO): Promise<void> {
    const { nodeIds, locationNodes, locations, subLocations, locationTags } = normalizeLocations([
      location,
    ]);
    if (locationNodes.length === 0) {
      return;
    }
    await this.#db.transaction().execute(async (trx) => {
      await trx.deleteFrom('locationTags').where('nodeId', 'in', nodeIds).execute();
      await trx.deleteFrom('locationNodes').where('parentId', 'in', nodeIds).execute();
      await upsertTable(this.#maxVars, trx, 'locationNodes', locationNodes, ['id']);
      if (locations.length > 0) {
        await upsertTable(this.#maxVars, trx, 'locations', locations, ['nodeId'], ['dateAdded']);
      }
      if (subLocations.length > 0) {
        await upsertTable(this.#maxVars, trx, 'subLocations', subLocations, ['nodeId']);
      }
      if (locationTags.length > 0) {
        await upsertTable(this.#maxVars, trx, 'locationTags', locationTags, ['nodeId', 'tagId']);
      }
    });
    this.#notifyChange();
  }

  async removeLocation(location: ID): Promise<void> {
    console.info('SQLite: Removing location...', location);
    // Cascade delte in other tables deleting from locationNodes table.
    await this.#db.deleteFrom('locationNodes').where('id', '=', location).execute();
    // Run VACUUM to free disk space after large deletions.
    await sql`VACUUM;`.execute(this.#db);
    this.#notifyChange();
  }
}

function normalizeLocations(sourcelocations: LocationDTO[]) {
  const locationNodes: Insertable<LocationNodes>[] = [];
  const locations: Insertable<Locations>[] = [];
  const subLocations: Insertable<SubLocations>[] = [];
  const locationTags: Insertable<LocationTags>[] = [];
  const nodeIds: ID[] = [];

  function normalizeLocationNodeRecursive(
    node: LocationDTO | SubLocationDTO,
    parentId: ID | null,
    isRoot: boolean,
  ) {
    const parentIdvalue = isRoot ? null : parentId;
    const pathValue = 'path' in node ? node.path : node.name;
    nodeIds.push(node.id);
    locationNodes.push({
      id: node.id,
      parentId: parentIdvalue,
      path: pathValue,
    });
    if (isRoot) {
      const location = node as LocationDTO;
      locations.push({
        nodeId: node.id,
        idx: location.index,
        isWatchingFiles: serializeBoolean(!!location.isWatchingFiles),
        dateAdded: serializeDate(new Date(location.dateAdded)),
      });
    } else {
      const subLocation = node as SubLocationDTO;
      subLocations.push({
        nodeId: node.id,
        isExcluded: serializeBoolean(subLocation.isExcluded),
      });
    }
    // Insert tags
    for (const tagId of Array.isArray(node.tags) ? node.tags : []) {
      locationTags.push({
        nodeId: node.id,
        tagId: tagId,
      });
    }
    // Recurse for sublocations
    for (const sub of Array.isArray(node.subLocations) ? node.subLocations : []) {
      normalizeLocationNodeRecursive(sub, node.id, false);
    }
  }

  for (const loc of sourcelocations) {
    normalizeLocationNodeRecursive(loc, null, true);
  }
  return { nodeIds, locationNodes, locations, subLocations, locationTags };
}
