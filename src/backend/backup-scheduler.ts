import { promises as fs } from 'fs';
import { Insertable, InsertObject, Kysely, sql } from 'kysely';
import { generateId, ID } from 'src/api/id';
import { ROOT_TAG_ID } from 'src/api/tag';
import {
  AllusionDB_SQL,
  EpValuesNumber,
  EpValuesText,
  EpValuesTimestamp,
  ExtraProperties,
  Files,
  FileTags,
  LocationNodes,
  Locations,
  LocationTags,
  SavedSearches,
  serializeBoolean,
  serializeDate,
  SubLocations,
  SearchCriteria,
  TagImplications,
  TagAliases,
} from './schemaTypes';
import { ExtraPropertyType } from 'src/api/extraProperty';

const fallbackIds = {
  tag: 'fallback_tag',
  location: 'fallback_location',
  locationNode: 'fallback_location_node',
  extraProperty: 'fallback_ep',
};

export async function restoreFromOldJsonFormat(
  db: Kysely<AllusionDB_SQL>,
  backupFilePath: string,
): Promise<void> {
  const content = await fs.readFile(backupFilePath, 'utf8');
  const json = JSON.parse(content);
  console.log('====================================================');
  console.log('[] Importing Dexie backup from', backupFilePath, '[]');
  if (json.formatName !== 'dexie') {
    throw new Error('Invalid backup format (expected dexie)');
  }

  const tables = Object.fromEntries(
    json.data.data.map((table: any) => [table.tableName, table.rows]),
  );

  const saveEntries = async <
    TableName extends keyof AllusionDB_SQL, // nombre de tabla (clave)
  >(
    entityName: TableName,
    entries: InsertObject<AllusionDB_SQL, TableName>[],
  ) => {
    let errors = 0;
    console.log(`Importing ${entries.length} ${entityName} from old format.`);
    await db.transaction().execute(async (trx) => {
      const batchSize = 2000;
      for (let i = 0; i < entries.length; i += batchSize) {
        try {
          const batch = entries.slice(i, i + batchSize);
          await trx
            .insertInto(entityName)
            .values(batch)
            .onConflict((oc) => oc.doNothing())
            .execute();
        } catch (err) {
          console.warn(`Insert ${entityName} error`, err);
          errors += batchSize;
        }
      }
    });
    console.log(`Finished importing ${entityName}: ${errors} errors.`);
  };

  // Disable foreign key constraints
  await sql`PRAGMA foreign_keys = OFF;`.execute(db);

  // Create fallback references for missing foreign keys
  // Ensure fallback base records exist
  await db
    .insertInto('tags')
    .values({
      id: fallbackIds.tag,
      parentId: ROOT_TAG_ID,
      idx: 0,
      name: 'Fallback Tag',
      color: '',
      description: '',
      isHidden: serializeBoolean(false),
      isVisibleInherited: serializeBoolean(true),
      isHeader: serializeBoolean(false),
      dateAdded: serializeDate(new Date()),
    })
    .onConflict((oc) => oc.doNothing())
    .execute();

  await db
    .insertInto('locationNodes')
    .values({
      id: fallbackIds.locationNode,
      parentId: fallbackIds.locationNode,
      path: 'fallback',
    })
    .onConflict((oc) => oc.doNothing())
    .execute();

  await db
    .insertInto('locations')
    .values({
      nodeId: fallbackIds.locationNode,
      idx: 0,
      isWatchingFiles: serializeBoolean(false),
      dateAdded: serializeDate(new Date()),
    })
    .onConflict((oc) => oc.doNothing())
    .execute();

  await db
    .insertInto('extraProperties')
    .values({
      id: fallbackIds.extraProperty,
      name: 'Fallback Property',
      type: 'text',
      dateAdded: serializeDate(new Date()),
    })
    .onConflict((oc) => oc.doNothing())
    .execute();

  /// IMPORTING DATA ///

  // Import tags
  const { normalizedTags, tagImplications, tagAliases } = normalizeTags(tables.tags ?? []);

  await saveEntries('tags', normalizedTags);
  await saveEntries('tagImplications', tagImplications);
  await saveEntries('tagAliases', tagAliases);

  // Import locations
  const { locationNodes, locations, subLocations } = normalizeLocations(tables.locations ?? []);

  await saveEntries('locationNodes', locationNodes);
  await saveEntries('locations', locations);
  await saveEntries('subLocations', subLocations);

  // Import extra properties definitions
  const extraProperties: Insertable<ExtraProperties>[] = (
    tables.extraProperties ? (tables.extraProperties as Array<any>) : []
  ).map((ep) => ({
    id: ep.id ?? generateId(),
    type: ep.type ?? ExtraPropertyType.text,
    name: ep.name ?? '(unnamed)',
    dateAdded: serializeDate(ep.dateAdded ? new Date(ep.dateAdded) : new Date()),
  }));

  await saveEntries('extraProperties', extraProperties);

  // Import files
  const { files, fileTags, epValText, epValNumber, epValTime } = normalizeFiles(
    tables.files ?? [],
    extraProperties,
  );

  await saveEntries('files', files);
  await saveEntries('fileTags', fileTags);
  await saveEntries('epValuesText', epValText);
  await saveEntries('epValuesNumber', epValNumber);
  await saveEntries('epValuesTimestamp', epValTime);

  // Import seved searches
  const { savedSearches, searchCriteria } = normalizeSavedSearches(tables.searches ?? []);
  await saveEntries('savedSearches', savedSearches);
  await saveEntries('searchCriteria', searchCriteria);

  //  Re-enable foreign keys
  await sql`PRAGMA foreign_keys = ON;`.execute(db);

  //  Validate foreign keys
  const fkCheck = await sql`PRAGMA foreign_key_check;`.execute(db);
  if (fkCheck.rows.length > 0) {
    console.warn('Foreign key issues found:', fkCheck.rows);
    // optional cleanup: remove invalid references
    await sql`DELETE FROM files WHERE location_id NOT IN (SELECT node_id FROM locations);`.execute(
      db,
    );
    await sql`DELETE FROM file_tags WHERE tag_id NOT IN (SELECT id FROM tags);`.execute(db);
  } else {
    console.log('Complete succes! no foreign key issues found:', fkCheck.rows);
  }

  console.log('Dexie backup import completed successfully.');
  console.log('====================================================');
}

export async function down(_: Kysely<any>): Promise<void> {
  // No rollback for imports, maybe delete fallback and imported data
  void _;
}

function normalizeTags(tags: any[]) {
  const parentMap = new Map<ID, [ID | null, number]>();
  const tagImplications: Insertable<TagImplications>[] = [];
  const tagAliases: Insertable<TagAliases>[] = [];

  for (const tag of tags) {
    for (const [idx, childId] of (Array.isArray(tag.subTags) ? tag.subTags : []).entries()) {
      parentMap.set(childId, [tag.id, idx]);
    }
    if (!parentMap.has(tag.id)) {
      parentMap.set(tag.id, [ROOT_TAG_ID, 0]);
    }

    for (const impliedTagId of Array.isArray(tag.impliedTags) ? tag.impliedTags : []) {
      tagImplications.push({ tagId: tag.id, impliedTagId: impliedTagId });
    }

    // Convert to Set to get rid of duplicates.
    const aliases = new Set<string>(Array.isArray(tag.aliases) ? tag.aliases : []);
    for (const alias of aliases) {
      tagAliases.push({ tagId: tag.id, alias: alias });
    }
  }

  const normalizedTags = tags.map((tag) => ({
    id: tag.id ?? generateId(),
    parentId: (parentMap.get(tag.id)?.at(0) ?? fallbackIds.tag) as ID,
    idx: (parentMap.get(tag.id)?.at(1) ?? 0) as number,
    name: tag.name ?? '(untitled)',
    color: tag.color ?? '',
    isHidden: serializeBoolean(!!tag.isHidden),
    isVisibleInherited: serializeBoolean(!!tag.isVisibleInherited),
    isHeader: serializeBoolean(!!tag.isHeader),
    description: tag.description ?? '',
    dateAdded: serializeDate(tag.dateAdded ? new Date(tag.dateAdded) : new Date()),
  }));

  return { normalizedTags, tagImplications, tagAliases };
}

function normalizeLocations(sourcelocations: any[]) {
  const locationNodes: Insertable<LocationNodes>[] = [];
  const locations: Insertable<Locations>[] = [];
  const subLocations: Insertable<SubLocations>[] = [];
  const locationTags: Insertable<LocationTags>[] = [];

  function normalizeLocationNodeRecursive(
    node: any, //LocationDTO | SubLocationDTO,
    parentId: ID,
    isRoot: boolean,
  ) {
    const nodeId = node.id ?? generateId();
    const parentIdvalue = isRoot ? nodeId : parentId;
    const pathValue = isRoot ? node.path ?? '' : node.name ?? '';
    // Insert into locationNodes
    locationNodes.push({
      id: nodeId,
      parentId: parentIdvalue,
      path: pathValue,
    });
    if (isRoot) {
      locations.push({
        nodeId: nodeId,
        idx: node.index ?? 0,
        isWatchingFiles: serializeBoolean(!!node.isWatchingFiles),
        dateAdded: serializeDate(node.dateAdded ? new Date(node.dateAdded) : new Date()),
      });
    } else {
      // Insert into sub_location
      subLocations.push({
        nodeId: nodeId,
        isExcluded: serializeBoolean(!!node.isExcluded),
      });
    }
    // Insert tags
    for (const tagId of Array.isArray(node.tags) ? node.tags : []) {
      locationTags.push({
        nodeId: nodeId,
        tagId: tagId,
      });
    }
    // Recurse for sublocations
    for (const sub of Array.isArray(node.subLocations) ? node.subLocations : []) {
      normalizeLocationNodeRecursive(sub, nodeId, false);
    }
  }

  for (const loc of sourcelocations) {
    normalizeLocationNodeRecursive(loc, loc.id ?? generateId(), true);
  }
  return { locationNodes, locations, subLocations };
}

function normalizeFiles(sourceFiles: any[], extraProperties: Insertable<ExtraProperties>[]) {
  const files: Insertable<Files>[] = [];
  const fileTags: Insertable<FileTags>[] = [];
  const epValText: Insertable<EpValuesText>[] = [];
  const epValNumber: Insertable<EpValuesNumber>[] = [];
  const epValTime: Insertable<EpValuesTimestamp>[] = [];

  for (const file of sourceFiles) {
    const fileId = file.id ?? generateId();
    files.push({
      id: fileId,
      ino: file.ino ?? '',
      locationId: file.locationId ?? fallbackIds.locationNode,
      relativePath: file.relativePath ?? '',
      absolutePath: file.absolutePath ?? '',
      tagSorting: file.tagsSorting ?? 'none',
      name: file.name ?? '(unnamed)',
      extension: file.extension ?? '',
      size: file.size ?? 10,
      width: file.width ?? 10,
      height: file.height ?? 10,
      dateAdded: serializeDate(file.dateAdded ? new Date(file.dateAdded) : new Date()),
      dateModified: serializeDate(file.dateModified ? new Date(file.dateModified) : new Date()),
      dateModifiedOS: serializeDate(
        file.dateModifiedOS ? new Date(file.dateModifiedOS) : new Date(),
      ),
      dateLastIndexed: serializeDate(
        file.dateLastIndexed ? new Date(file.dateLastIndexed) : new Date(),
      ),
      dateCreated: serializeDate(file.dateCreated ? new Date(file.dateCreated) : new Date()),
    });

    // file_tags (tags relations)
    for (const tagId of Array.isArray(file.tags) ? file.tags : []) {
      fileTags.push({
        fileId: fileId,
        tagId: tagId,
      });
    }

    // ep_values  (extra properties relations)
    if (file.extraPropertyIDs) {
      for (const epId of Array.isArray(file.extraPropertyIDs) ? file.extraPropertyIDs : []) {
        const epRow = extraProperties.find((ep: any) => ep.id === epId);

        const value = file.extraProperties?.[epId];
        if (value !== undefined && value !== null) {
          const epType = epRow?.type ?? typeof value;
          if (epType === 'number') {
            epValNumber.push({
              fileId,
              epId,
              value: value,
            });
          } else if (epType === 'timestamp' || value instanceof Date) {
            epValTime.push({
              fileId,
              epId,
              value: serializeDate(value),
            });
          } else {
            epValText.push({
              fileId,
              epId,
              value: value,
            });
          }
        }
      }
    }
  }
  return { files, fileTags, epValText, epValNumber, epValTime };
}

function normalizeSavedSearches(sourceSearches: any[]) {
  const savedSearches: Insertable<SavedSearches>[] = [];
  const searchCriteria: Insertable<SearchCriteria>[] = [];

  for (const search of sourceSearches) {
    const searchId = search.id ?? generateId();
    savedSearches.push({
      id: searchId,
      name: search.name ?? '(unnamed search)',
      idx: search.index ?? 0,
    });

    for (const [idx, crit] of (Array.isArray(search.criteria) ? search.criteria : []).entries()) {
      const criteriaId = generateId();
      searchCriteria.push({
        id: criteriaId,
        savedSearchId: searchId,
        idx: idx,
        matchGroup: search.matchAny ? 'any' : 'all',
        key: crit.key ?? 'name',
        valueType: crit.valueType ?? 'string',
        operator: crit.operator ?? 'equals',
        jsonValue: JSON.stringify(crit.value ?? 'error'),
      });
    }
  }
  return { savedSearches, searchCriteria };
}
