import {
  Kysely,
  sql,
  SelectQueryBuilder,
  SqlBool,
  ExpressionBuilder,
  OrderByDirection,
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
} from 'src/api/data-storage-search';
import { FileDTO } from 'src/api/file';
import { AllusionDB_SQL, Files, serializeDate } from './schemaTypes';
import { PadString, stableHash } from './db';

///////////////////
///// SORTING /////
///////////////////

const exampleFileDTO: FileDTO = {
  id: '',
  ino: '',
  name: '',
  relativePath: '',
  absolutePath: '',
  locationId: '',
  extension: 'jpg',
  tagSorting: 'hierarchy',
  size: 0,
  width: 0,
  height: 0,
  dateAdded: new Date(),
  dateCreated: new Date(),
  dateLastIndexed: new Date(),
  dateModified: new Date(),
  dateModifiedOS: new Date(),
  extraProperties: {},
  tags: [],
};

function isFileDTOPropString(prop: PropertyKeys<FileDTO>): prop is StringProperties<FileDTO> {
  return typeof exampleFileDTO[prop] === 'string';
}

function isValidCursor(cursor: any): cursor is Cursor {
  if (typeof cursor === 'object' && 'orderValue' in cursor && 'id' in cursor) {
    if (typeof cursor.id === 'string' && cursor.orderValue !== undefined) {
      return true;
    }
  }
  return false;
}

export type PaginationOptions = {
  order: OrderBy<FileDTO>;
  direction?: OrderDirection;
  useNaturalOrdering?: boolean;
  limit?: number;
  pagination?: PaginationDirection;
  cursor?: Cursor;
  extraPropertyID?: string;
  seed?: number;
};

// Original implementation by Pianissi
export async function applyPagination<O>(
  db: Kysely<AllusionDB_SQL>,
  q: SelectQueryBuilder<AllusionDB_SQL, 'files', O>,
  pagOptions: PaginationOptions,
): Promise<SelectQueryBuilder<AllusionDB_SQL, 'files', O>> {
  const { direction, useNaturalOrdering, extraPropertyID } = pagOptions;
  const { pagination, cursor, limit } = pagOptions;
  const { order } = pagOptions;

  let sqlDirection: OrderByDirection = direction === OrderDirection.Asc ? 'asc' : 'desc';
  let orderColumn: string | RawBuilder<unknown> =
    order === 'extraProperty' ? 'sortValue' : `files.${order}`;
  let type: 'text' | 'number' =
    order !== 'extraProperty' && order !== 'random' && isFileDTOPropString(order)
      ? 'text'
      : 'number';
  // Compute pagination consts
  const isAfter = pagination === 'after';
  const isAsc = sqlDirection === 'asc';
  const operator = isAfter === isAsc ? '>' : '<';
  const isValidPagination = isValidCursor(cursor) && pagination;
  // alter sqlDirection only if a valid pagination applies
  if (isValidPagination) {
    // if pagination === 'before' invert direction to fetch adjacent elements, then after executing the query apply a reverse to the result data.
    sqlDirection = !isAfter ? (isAsc ? 'desc' : 'asc') : sqlDirection;
  }

  /// add extraproperty optional value ///
  // because of how the joined table is returned as, we need to aggregate a sort value in the joined table which can be used as a key
  if (order === 'extraProperty') {
    const extraProp = await db
      .selectFrom('extraProperties' as any)
      .select('type')
      .where('id' as any, '=', extraPropertyID)
      .executeTakeFirst();

    if (!extraPropertyID || !extraProp) {
      q = q.select(sql<null>`NULL`.as('sortValue'));
    } else {
      // maping value type to column
      // TODO: add timestamp mapping when implementing that extra property
      const valueColumn = extraProp.type === 'text' ? 'textValue' : 'numberValue';
      type = extraProp.type === 'text' ? 'text' : 'number';
      // Left join the corresponding extraProperty value and select it as sortValue
      q = q
        .leftJoin('epValues', (join) =>
          join.onRef('epValues.fileId', '=', 'files.id').on('epValues.epId', '=', extraPropertyID),
        )
        .select(`epValues.${valueColumn} as sortValue` as any) as any;
    }
  }

  // convert columns to handle nulls in pagination this also applies the natural ordering formating
  const { safeColumn, safeOrderValue } = getOrderColumnExpression(
    orderColumn,
    type,
    cursor?.orderValue,
    direction, // use original direction since sqlDirection can be altered for pagination
    useNaturalOrdering,
    order === 'extraProperty',
  );
  orderColumn = safeColumn;

  // PAGINATION LOGIC
  if (isValidPagination) {
    const { id } = cursor;

    if (order === 'random') {
      // In random we use a pseudo random but stable hash value based on the cursor, this allow us to use pagination while order by random
      const seed = pagOptions.seed ?? 0;
      const cursorHash = stableHash(id, seed);
      q = q.where((eb) =>
        eb.or([
          eb(sql`stable_hash(files.id, ${seed})`, operator, cursorHash),
          eb.and([
            eb(sql`stable_hash(files.id, ${seed})`, '=', cursorHash),
            eb('files.id', operator, id),
          ]),
        ]),
      );
    } else {
      // Standard pagination: (orderColumn, id) > (orderValue, id)
      q = q.where((eb) =>
        eb.or([
          eb(orderColumn as any, operator, safeOrderValue),
          eb.and([eb(orderColumn as any, '=', safeOrderValue), eb('files.id', operator, id)]),
        ]),
      );
    }
  }
  //PAGINATION LOGIC END

  // Apply Ordering
  if (order === 'random') {
    const seed = pagOptions.seed ?? 0;
    q = q.orderBy(sql`stable_hash(files.id, ${seed})`, sqlDirection);
  } else {
    // Default
    q = q.orderBy(orderColumn as any, sqlDirection);
  }

  // Allways append order by some unique value, required for pagination
  q = q.orderBy('files.id', sqlDirection);

  // Apply limit
  if (limit) {
    q = q.limit(limit);
  }

  return q;
}

/**
 * Normalizes a column and its cursor value for consistent sorting.
 * Handles natural ordering via padding and provides fallback values
 * for null/undefined to ensure stable pagination.
 */
export function getOrderColumnExpression(
  columnName: string,
  type: 'text' | 'number',
  orderValue: unknown,
  direction?: OrderDirection,
  useNaturalOrdering?: boolean,
  useNullFallback?: boolean,
): { safeColumn: RawBuilder<unknown>; safeOrderValue: unknown } {
  const isAsc = direction === OrderDirection.Asc;
  const isText = type === 'text';

  // Set a fallback value per data type, Date is managed as number
  let fallbackValue;
  if (isText) {
    fallbackValue = isAsc ? '\uffff\uffff\uffff' : '';
  } else {
    fallbackValue = isAsc ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER;
  }

  let safeOrderValue =
    useNullFallback && (orderValue === null || orderValue === undefined)
      ? fallbackValue
      : orderValue;
  let colExpression = sql.ref(columnName);
  // Add PAD_STRING if needed
  if (isText && useNaturalOrdering) {
    safeOrderValue = PadString(String(safeOrderValue));
    colExpression = sql`PAD_STRING(${colExpression})`;
  }
  const safeColumn = useNullFallback
    ? sql`COALESCE(${colExpression}, ${fallbackValue})`
    : colExpression;

  return { safeColumn, safeOrderValue };
}

///////////////////////////
///////// FILTERS /////////
///////////////////////////

type MustIncludeFiles<T> = 'files' extends T ? T : never;

export type ConditionWithConjunction<T> = ConditionDTO<T> & {
  conjunction?: SearchConjunction;
};

export function applyFileFilters<
  DB extends AllusionDB_SQL,
  TB extends MustIncludeFiles<keyof DB>,
  O,
>(
  q: SelectQueryBuilder<DB, TB, O>,
  criteria?: ConditionGroupDTO<FileDTO>,
): SelectQueryBuilder<DB, TB, O> {
  if (!criteria || criteria.children.length === 0) {
    return q;
  }
  return q.where((eb) =>
    expressionFromNode(
      eb as ExpressionBuilder<AllusionDB_SQL, 'files'>,
      criteria as unknown as ConditionGroupDTO<Files>,
    ),
  );
}

function expressionFromNode(
  eb: ExpressionBuilder<AllusionDB_SQL, 'files'>,
  node: ConditionGroupDTO<Files> | ConditionDTO<Files>,
): ReturnType<typeof eb.or> | ReturnType<typeof expressionFromCriteria> {
  // if it's a condition
  if (!('children' in node)) {
    return expressionFromCriteria(eb, node);
  }
  // if it's a group recursively apply criterias
  const expressions = node.children.map((child) => expressionFromNode(eb, child)).filter(Boolean);
  // if no expressions return true for this criteria node
  if (expressions.length === 0) {
    return sql<SqlBool>`TRUE`;
  }
  return node.conjunction === 'or' ? eb.or(expressions) : eb.and(expressions);
}

const expressionFromCriteria = (
  eb: ExpressionBuilder<AllusionDB_SQL, 'files'>,
  crit: ConditionDTO<Files>,
) => {
  switch (crit.valueType) {
    case 'string':
      return applyStringCondition(eb, crit.key, crit.operator, crit.value);
    case 'number':
      return applyNumberCondition(eb, crit.key, crit.operator, crit.value);
    case 'date':
      return applyDateCondition(eb, crit.key, crit.operator, crit.value);
    case 'array':
      return applyTagArrayCondition(eb, crit.key, crit.operator, crit.value);
    case 'indexSignature':
      return applyExtraPropertyCondition(eb, crit.key, crit.operator, crit.value);
  }
};

function applyStringCondition(
  eb: ExpressionBuilder<AllusionDB_SQL, 'files'>,
  key: keyof Files,
  operator: StringOperatorType,
  value: string,
) {
  switch (operator) {
    case 'equals':
      return eb(`files.${key}`, '=', value);
    case 'equalsIgnoreCase':
      return eb(sql`lower(${sql.ref(`files.${key}`)})`, '=', value.toLowerCase());
    case 'notEqual':
      return eb(`files.${key}`, '!=', value);
    case 'contains':
      return eb(`files.${key}`, 'like', `%${value}%`);
    case 'notContains':
      // use NOT LIKE
      return eb(`files.${key}`, 'not like', `%${value}%`);
    case 'startsWith':
      return eb(`files.${key}`, 'like', `${value}%`);
    case 'startsWithIgnoreCase':
      return eb(sql`lower(${sql.ref(`files.${key}`)})`, 'like', `${value.toLowerCase()}%`);
    case 'notStartsWith':
      return eb(`files.${key}`, 'not like', `${value}%`);
    default:
      const _exhaustiveCheck: never = operator;
      return _exhaustiveCheck;
  }
}

function applyNumberCondition(
  eb: ExpressionBuilder<AllusionDB_SQL, 'files'>,
  key: keyof Files,
  operator: NumberOperatorType,
  value: number,
) {
  switch (operator) {
    case 'equals':
      return eb(`files.${key}`, '=', value);
    case 'notEqual':
      return eb(`files.${key}`, '!=', value);
    case 'smallerThan':
      return eb(`files.${key}`, '<', value);
    case 'smallerThanOrEquals':
      return eb(`files.${key}`, '<=', value);
    case 'greaterThan':
      return eb(`files.${key}`, '>', value);
    case 'greaterThanOrEquals':
      return eb(`files.${key}`, '>=', value);
    default:
      const _exhaustiveCheck: never = operator;
      return _exhaustiveCheck;
  }
}

function applyDateCondition(
  eb: ExpressionBuilder<AllusionDB_SQL, 'files'>,
  key: keyof Files,
  operator: NumberOperatorType,
  value: Date,
) {
  // In DB dates are DateAsNumber, convert Date to number.
  const startOfDay = new Date(value);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(value);
  endOfDay.setHours(23, 59, 59, 999);
  const s = serializeDate(startOfDay);
  const e = serializeDate(endOfDay);

  switch (operator) {
    case 'equals':
      // equal to this day, so between 0:00 and 23:59
      return eb(`files.${key}`, '>=', s).and(`files.${key}`, '<=', e);
    case 'notEqual':
      // not equal to this day, so before 0:00 or after 23:59
      return eb.or([eb(`files.${key}`, '<', s), eb(`files.${key}`, '>', e)]);
    case 'smallerThan':
      return eb(`files.${key}`, '<', s);
    case 'smallerThanOrEquals':
      return eb(`files.${key}`, '<=', e);
    case 'greaterThan':
      return eb(`files.${key}`, '>', e);
    case 'greaterThanOrEquals':
      return eb(`files.${key}`, '>=', s);
    default:
      const _exhaustiveCheck: never = operator;
      return _exhaustiveCheck;
  }
}

/**
 * Note / TODO:
 * Array and IndexSignature condition appliers would work the same way as the next two examples.
 * They could be used for any array or index signature property, but since those properties
 * only exist in the DTO objects (not in the raw fetched data from the database) and are instead
 * represented through relation tables, a mapping between the DTO property key and the corresponding
 * subquery table must be defined.
 *
 * Currently, since only the "tags" and "extraProperties" properties use these conditions,
 * the mapping is hard-coded to those specific database tables in each case.
 */

function applyTagArrayCondition(
  eb: ExpressionBuilder<AllusionDB_SQL, 'files'>,
  key: keyof FileDTO,
  operator: ArrayOperatorType,
  values: any[],
) {
  // If the key is not tags return a neutral condition (always true) to avoid breaking
  // the WHERE clause when no filter is applied
  if (key !== 'tags') {
    return sql<SqlBool>`TRUE`;
  }
  if (values.length === 0) {
    const anyTagFiles = eb.selectFrom('fileTags').select('fileId').distinct();
    if (operator === 'contains') {
      // files with 0 tags -> NOT EXISTS fileTags for this file
      return eb.not(eb('files.id', 'in', anyTagFiles));
    } else {
      // notContains empty -> files which have at least one tag
      return eb('files.id', 'in', anyTagFiles);
    }
  } else {
    const matchingFiles = eb
      .selectFrom('fileTags')
      .select('fileId')
      .where('tagId', 'in', values)
      .distinct();
    if (operator === 'contains') {
      return eb('files.id', 'in', matchingFiles);
    } else {
      // notContains: ensure NOT EXISTS any tag in the list for that file
      return eb.not(eb('files.id', 'in', matchingFiles));
    }
  }
}

function applyExtraPropertyCondition(
  eb: ExpressionBuilder<AllusionDB_SQL, 'files'>,
  key: keyof FileDTO,
  operator: NumberOperatorType | StringOperatorType | ExtraPropertyOperatorType,
  valueTuple: [string, any],
) {
  // If the key is not extraProperties return a neutral condition (always true)
  // to avoid breaking the WHERE clause when no filter is applied
  if (key !== 'extraProperties') {
    return sql<SqlBool>`TRUE`;
  }
  const [epID, innerValue] = valueTuple;
  let subquery = eb
    .selectFrom('extraProperties')
    .innerJoin('epValues', 'extraProperties.id', 'epValues.epId')
    .select('epValues.fileId')
    .distinct()
    .where('extraProperties.id', '=', epID);
  //.whereRef('epValues.fileId', '=', sql.ref('files.id'));

  if (operator === 'existsInFile') {
    return eb('files.id', 'in', subquery);
  }

  if (operator === 'notExistsInFile') {
    return eb.not(eb('files.id', 'in', subquery));
  }

  // For typed comparisons add an echtra filter to the subquery
  if (typeof innerValue === 'number' && isNumberOperator(operator)) {
    // prettier-ignore
    // use epValues.numberValue
    switch (operator) {
        case 'equals':
          subquery = subquery.where('epValues.numberValue', '=', innerValue);
          break;
        case 'notEqual':
          subquery = subquery.where('epValues.numberValue', '!=', innerValue);
          break;
        case 'greaterThan':
          subquery = subquery.where('epValues.numberValue', '>', innerValue);
          break;
        case 'greaterThanOrEquals':
          subquery = subquery.where('epValues.numberValue', '>=', innerValue);
          break;
        case 'smallerThan':
          subquery = subquery.where('epValues.numberValue', '<', innerValue);
          break;
        case 'smallerThanOrEquals':
          subquery = subquery.where('epValues.numberValue', '<=', innerValue);
          break;
        default:
          const _exhaustiveCheck: never = operator;
          return _exhaustiveCheck;
      }
  } else if (typeof innerValue === 'string' && isStringOperator(operator)) {
    // prettier-ignore
    // use epValues.textValue
    switch (operator) {
        case 'equals':
          subquery = subquery.where('epValues.textValue', '=', innerValue);
          break;
        case 'equalsIgnoreCase':
          subquery = subquery.where(sql`LOWER(${sql.ref('epValues.textValue')})`, '=', innerValue.toLowerCase());
          break;
        case 'notEqual':
          subquery = subquery.where('epValues.textValue', '=', innerValue);
          break;
        case 'contains':
          subquery = subquery.where('epValues.textValue', 'like', `%${innerValue}%`);
          break;
        case 'notContains':
          subquery = subquery.where('epValues.textValue', 'not like', `%${innerValue}%`);
          break;
        case 'startsWith':
          subquery = subquery.where('epValues.textValue', 'like', `${innerValue}%`);
          break;
        case 'notStartsWith':
          subquery = subquery.where('epValues.textValue', 'not like', `${innerValue}%`);
          break;
        case 'startsWithIgnoreCase':
          subquery = subquery.where(sql`LOWER(${sql.ref('epValues.textValue')})`, 'like', `${innerValue.toLowerCase()}%`);
          break;
        default:
          const _exhaustiveCheck: never = operator;
          return _exhaustiveCheck;
      }
  } else {
    throw new Error('Unsupported indexSignature value type');
  }
  // Return the expression
  return eb('files.id', 'in', subquery);
}

// TODO: Move to src/backend/repositories/SemanticRepository.ts when that file is created.

/**
 * Computes sample timestamps (in seconds) from a video duration and a list of ratios.
 */
export function computeSampleTimestamps(
  durationSeconds: number,
  ratios: readonly number[],
): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [0, 1, 2, 3].slice(0, ratios.length);
  }

  const maxTimestamp = Math.max(0, durationSeconds - 0.05);
  return ratios.map((ratio) => {
    const normalizedRatio = Math.min(1, Math.max(0, ratio));
    return Math.min(maxTimestamp, durationSeconds * normalizedRatio);
  });
}

/**
 * Computes the mean-pooled (and L2-normalized) embedding from multiple frame embeddings.
 */
export function meanPoolEmbeddings(embeddings: number[][]): number[] {
  const first = embeddings[0];
  const sum = first.slice();

  for (let i = 1; i < embeddings.length; i++) {
    const current = embeddings[i];
    if (current.length !== sum.length) {
      throw new Error('Cannot aggregate semantic video frame embeddings with mismatched sizes.');
    }
    for (let dim = 0; dim < sum.length; dim++) {
      sum[dim] += current[dim];
    }
  }

  for (let dim = 0; dim < sum.length; dim++) {
    sum[dim] /= embeddings.length;
  }

  let norm = 0;
  for (const value of sum) {
    norm += value * value;
  }
  if (norm <= 0) {
    return sum;
  }

  const scale = 1 / Math.sqrt(norm);
  return sum.map((value) => value * scale);
}
