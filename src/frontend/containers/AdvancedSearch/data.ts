import { generateWidgetId } from 'widgets/utility';
import {
  ExtraPropertyOperatorType,
  NumberOperatorType,
  SearchConjunction,
  StringOperatorType,
} from '../../../api/data-storage-search';
import { FileDTO, IMG_EXTENSIONS } from '../../../api/file';
import { generateId, ID } from '../../../api/id';
import { BinaryOperatorType, OperatorType, TagOperatorType } from '../../../api/search-criteria';
import {
  ClientDateSearchCriteria,
  ClientExtraPropertySearchCriteria,
  ClientFileSearchCriteria,
  ClientNumberSearchCriteria,
  ClientStringSearchCriteria,
  ClientTagSearchCriteria,
} from '../../entities/SearchCriteria';
import TagStore from '../../stores/TagStore';
import { ExtraPropertyType, ExtraPropertyValue } from 'src/api/extraProperty';
import { ClientSearchGroup, isClientSearchGroup } from 'src/frontend/entities/SearchItem';
import { clamp } from 'common/core';

export type Query = CriteriaGroup;
export type QueryDispatch = React.Dispatch<React.SetStateAction<Query>>;

export function generateCriteriaId() {
  return generateWidgetId('__criteria');
}

export function generateGroupId() {
  return generateWidgetId('__group');
}

export type CriteriaNode = Criteria | CriteriaGroup;

export type GroupMap = Map<string, CriteriaNode>;

export type CriteriaGroup = {
  id: ID;
  name: string;
  conjunction: SearchConjunction;
  children: GroupMap;
};

export function isCriteriaGroup(obj: any): obj is CriteriaGroup {
  return obj && typeof obj === 'object' && 'children' in obj;
}

// Type Key and assigned Criteria K must overlap completely
export type Criteria =
  | Field<'name' | 'absolutePath', StringOperatorType, string>
  | Field<'tags', TagOperatorType, TagValue>
  | Field<'extension', BinaryOperatorType, string>
  | Field<'size', NumberOperatorType, number>
  | Field<'width' | 'height', NumberOperatorType, number>
  | Field<'dateAdded' | 'dateCreated' | 'dateModified' | 'dateModifiedOS', NumberOperatorType, Date>
  | ExtraPropertyField<ExtraPropertyID, ExtraPropertyOperatorType, any>
  | ExtraPropertyField<ExtraPropertyID, NumberOperatorType, number>
  | ExtraPropertyField<ExtraPropertyID, StringOperatorType, string>;

interface Field<K extends Key, O extends Operator, V extends Value> {
  id: ID;
  key: K;
  operator: O;
  value: V;
}

interface ExtraPropertyField<
  EP extends ExtraPropertyID,
  O extends Operator = StringOperatorType | NumberOperatorType,
  V extends Value = ExtraPropertyValue,
> extends Field<'extraProperties', O, V> {
  extraProperty: EP;
}

export type Key = keyof Pick<
  FileDTO,
  | 'tags'
  | 'name'
  | 'absolutePath'
  | 'extension'
  | 'size'
  | 'width'
  | 'height'
  | 'dateAdded'
  | 'dateCreated'
  | 'dateModified'
  | 'dateModifiedOS'
  | 'extraProperties'
>;

export const FileKeyOptions: Record<Key, string> = {
  tags: 'Tags',
  name: 'File Name',
  absolutePath: 'File Path',
  size: 'File Size (MB)',
  width: 'Width',
  height: 'Height',
  extension: 'File Extension',
  dateAdded: 'Date Added',
  dateCreated: 'Date Created',
  dateModified: 'Date Modified In App',
  dateModifiedOS: 'Date Modified',
  extraProperties: 'Extra Property',
};

export const QuickSearchKeyOptions = {
  tags: FileKeyOptions.tags,
  name: FileKeyOptions.name,
  absolutePath: FileKeyOptions.absolutePath,
  extension: FileKeyOptions.extension,
  size: FileKeyOptions.size,
  width: FileKeyOptions.width,
  height: FileKeyOptions.height,
  extraProperties: FileKeyOptions.extraProperties,
} as const;

export type Operator = OperatorType;
export type Value = string | number | Date | TagValue | ExtraPropertyValue;
export type TagValue = ID | undefined;
export type ExtraPropertyID = ID | undefined;

export function getemptyQuery(): Query {
  return {
    id: generateGroupId(),
    name: '',
    conjunction: 'and',
    children: new Map(),
  };
}

//prettier-ignore
export function defaultQuery(key: Key, extraPropertyType?: ExtraPropertyType): Criteria {
  switch (key) {
    case 'name':
    case 'absolutePath':
      return { id: generateId(), key, operator: 'contains', value: '' };
    case 'tags':
      return { id: generateId(), key, operator: 'contains', value: undefined };
    case 'extension':
      return { id: generateId(),  key,  operator: 'equals',  value: IMG_EXTENSIONS[0] };
    case 'dateAdded':
    case 'dateCreated':
    case 'dateModified':
    case 'dateModifiedOS':
      return { id: generateId(), key, operator: 'equals', value: new Date() };
    case 'size':
    case 'width':
    case 'height':
      return {
        id: generateId(),
        key: key,
        operator: 'greaterThanOrEquals',
        value: 0,
      };
    case 'extraProperties': {
      if (extraPropertyType !== undefined) {
        if (extraPropertyType === ExtraPropertyType.number) {
          return {
            id: generateId(),
            extraProperty: undefined,
            key: 'extraProperties',
            value: 0,
            operator: 'equals',
          };
        } else if (extraPropertyType === ExtraPropertyType.text) {
          return {
            id: generateId(),
            extraProperty: undefined,
            key: 'extraProperties',
            value: '',
            operator: 'contains',
          };
        }
      }
      return {
        id: generateId(),
        extraProperty: undefined,
        key: 'extraProperties',
        value: 0,
        operator: 'equals',
      };
    }
    default: {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _exhaustiveCheck: never = key;
      return {
        id: generateId(),
        key: key,
        operator: 'greaterThanOrEquals',
        value: 0,
      };
    }
  }
}

export const BYTES_IN_MB = 1024 * 1024;

//prettier-ignore
export function fromCriteria(criteria: ClientFileSearchCriteria): [ID, Criteria] {
  const query = defaultQuery('tags');
  const key = criteria.key as Key;
  let isMatched = false;
  // Preserve the value when the criteria has the same type of value
  switch (key) {
    case 'name':
    case 'absolutePath':
    case 'extension':
      if (criteria instanceof ClientStringSearchCriteria) {
        query.value = criteria.value;
        isMatched = true;
      }
      break;
    case 'dateAdded':
    case 'dateCreated':
    case 'dateModifiedOS':
    case 'dateModified':
      if (criteria instanceof ClientDateSearchCriteria) {
        query.value = criteria.value;
        isMatched = true;
      }
      break;
    case 'size':
      if (criteria instanceof ClientNumberSearchCriteria) {
        query.value = criteria.value / BYTES_IN_MB;
        isMatched = true;
      }
      break;
    case 'width':
    case 'height':
      if (criteria instanceof ClientNumberSearchCriteria) {
        query.value = criteria.value;
        isMatched = true;
      }
      break;
    case 'tags':
      if (criteria instanceof ClientTagSearchCriteria) {
        query.value = criteria.value;
        isMatched = true;
      }
      break;
    case 'extraProperties':
      if (criteria instanceof ClientExtraPropertySearchCriteria) {
        (
          query as ExtraPropertyField<
            ExtraPropertyID,
            StringOperatorType | NumberOperatorType,
            ExtraPropertyValue
          >
        ).extraProperty = criteria.value[0];
        query.value = criteria.value[1];
        isMatched = true;
      }
      break;
    default:
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _exhaustiveCheck: never = key;
      break;
  }
  if (isMatched) {
    query.key = criteria.key as Key;
    query.operator = criteria.operator;
  }
  return [generateCriteriaId(), query];
}

/** Converts a ClientSearchGroup tree into a Query tree */
export function queryFromCriteria(criteria: ClientSearchGroup): Query {
  return {
    id: generateId(),
    name: criteria.name,
    conjunction: criteria.conjunction,
    children: new Map(
      criteria.children.map<[ID, Criteria | CriteriaGroup]>((child) => {
        if (isClientSearchGroup(child)) {
          return [generateGroupId(), queryFromCriteria(child) as CriteriaGroup];
        } else {
          return fromCriteria(child);
        }
      }),
    ),
  };
}

//prettier-ignore
export function intoCriteria(query: Criteria, tagStore: TagStore): ClientFileSearchCriteria {
  const key = query.key;
  switch (key) {
    case 'name':
    case 'absolutePath':
    case 'extension':
      return new ClientStringSearchCriteria(query.id, key, query.value, query.operator);
    case 'dateAdded':
    case 'dateCreated':
    case 'dateModified':
    case 'dateModifiedOS':
      return new ClientDateSearchCriteria(query.id, key, query.value, query.operator);
    case 'size':
      return new ClientNumberSearchCriteria(query.id, key, query.value * BYTES_IN_MB, query.operator);
    case 'width':
    case 'height':
      return new ClientNumberSearchCriteria(query.id, key, query.value, query.operator);
    case 'tags': {
      const tag = query.value !== undefined ? tagStore.get(query.value) : undefined;
      return new ClientTagSearchCriteria(query.id, 'tags', tag?.id, query.operator);
    }
    case 'extraProperties':
      return new ClientExtraPropertySearchCriteria(
        query.id,
        key,
        [query.extraProperty ?? '', query.value],
        query.operator,
      );
    default: {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _exhaustiveCheck: never = key;
      return new ClientTagSearchCriteria(undefined, 'tags');
    }
  }
}

export function intoGroup(query: Query, tagStore: TagStore): ClientSearchGroup {
  const nodeId = generateId();
  const group = new ClientSearchGroup(nodeId, query.name, query.conjunction, []);

  for (const crit of query.children.values()) {
    if (isCriteriaGroup(crit)) {
      group.insertNode(nodeId, intoGroup(crit, tagStore));
    } else {
      group.insertNode(nodeId, intoCriteria(crit, tagStore));
    }
  }
  return group;
}

export type CritPath = string[];
export type CritIndexPath = number[];

export function getPathByIndexPath(query: Query, indexPath: CritIndexPath): CritPath | null {
  let children = Array.from(query.children.entries());
  const path: CritPath = [];
  for (const index of indexPath) {
    if (index < 0 || index >= children.length) {
      // if index out of range, add a new group id and return, later when used into updateNode it will get undefined node
      // and will decide what to do with if in each updateNode fn argument
      path.push(generateGroupId());
      return path;
    }
    const [groupKey, node] = children[index];
    if (isCriteriaGroup(node)) {
      path.push(groupKey);
      children = Array.from(node.children.entries());
    } else {
      // if is not group, add the id, stop the loop and return
      path.push(groupKey);
      return path;
    }
  }
  return path;
}

export function cloneGroup(group: CriteriaGroup): CriteriaGroup {
  return {
    ...group,
    children: new Map(group.children),
  };
}

export function getNode(
  query: Query,
  path: CritPath,
  limit: number = path.length,
): CriteriaGroup | Criteria | null {
  if (path.length === 0) {
    return query;
  }
  const len = path.length;
  const normalizedLimit = Math.min(len, Math.max(0, limit < 0 ? len + limit : limit));

  let current: CriteriaGroup | Criteria | null = query;
  for (let i = 0; i < normalizedLimit; i++) {
    if (!isCriteriaGroup(current)) {
      return null;
    }
    const next = current.children.get(path[i]);
    current = next ?? null;
  }

  return current;
}

/** it search for a node given a path, rebuilding the path's nodes along
 * the way and update the target node with the provided updater function */
export function updateNode(
  query: Query,
  path: CritPath,
  fn: (node: CriteriaNode | undefined) => CriteriaNode | null = (node) =>
    node ? { ...node } : null,
): Query {
  let children = new Map(query.children);
  query.children = children;
  for (const id of path) {
    let node = children.get(id);
    if (id === path.at(-1)) {
      const updated = fn(node);
      if (updated === null) {
        // delete node
        children.delete(id);
      } else {
        children.set(id, updated);
      }
    } else if (node && isCriteriaGroup(node)) {
      node = { ...node, children: new Map(node.children) };
      children.set(id, node);
      children = node.children;
    }
  }
  if (path.length === 0) {
    const updated = fn(query);
    return updated && isCriteriaGroup(updated) ? { ...updated } : { ...query };
  }
  return { ...query };
}

export function deleteNode(
  query: Query,
  path: CritPath,
  deletedCallback?: (deletedNode: CriteriaNode | undefined) => void,
): Query {
  const parentPath = path.slice(0, -1);
  const targetId = path.at(-1);
  return updateNode(query, parentPath, (parent) => {
    if (!parent) {
      return null;
    }
    if (targetId && isCriteriaGroup(parent)) {
      const newChildren = new Map(parent.children);
      deletedCallback?.(newChildren.get(targetId));
      newChildren.delete(targetId);
      if (newChildren.size === 0 && parentPath.length > 0) {
        // prevent empty groups except for root
        return null;
      }
      return { ...parent, children: newChildren };
    }
    return { ...parent };
  });
}

export function insertNode(
  query: Query,
  path: CritPath,
  node: CriteriaNode,
  nodeId: string,
  at?: number,
  parentIndex?: number,
): Query {
  const toParentId = path.at(-1);
  let generatedGroupToInsert: CriteriaGroup | undefined;
  query = updateNode(query, path, (parent) => {
    if (isCriteriaGroup(parent)) {
      // if parent is group insert into it
      const newChildren = new Map(parent.children);
      const entries = Array.from(newChildren.entries());
      const insertAt = clamp(at ?? entries.length, 0, entries.length);
      entries.splice(insertAt, 0, [nodeId as ID, node]);
      return { ...parent, children: new Map(entries) };
    } else {
      // if parent is crieria insert both into new group
      // if parent is null insert into new group
      const entries: [string, CriteriaNode][] = parent
        ? [[toParentId ?? generateCriteriaId(), parent]]
        : [];
      entries.splice(at ?? entries.length, 0, [nodeId as ID, node]);
      const newGroup: CriteriaGroup = {
        id: generateId(),
        name: '',
        conjunction: 'and',
        children: new Map<string, CriteriaNode>(entries),
      };
      generatedGroupToInsert = newGroup;
      // return null to delete the previous criteria node
      return null;
    }
  });
  if (!generatedGroupToInsert) {
    return query;
  }
  const newGroupToInsert: CriteriaGroup = { ...generatedGroupToInsert };
  // if new group was created, insert it into the query
  query = insertNode(query, path.slice(0, -1), newGroupToInsert, generateGroupId(), parentIndex);
  /*
  query = updateNode(query, path.slice(0, -1), (parent) => {
    if (!parent) {
      return null;
    }
    if (isCriteriaGroup(parent)) {
      const newChildren = new Map(parent.children);
      newChildren.set(generateGroupId(), newGroupToInsert);
      return { ...parent, children: newChildren };
    }
    return parent;
  });*/
  return query;
}

export function moveNode(
  query: Query,
  fromPath: CritPath,
  toPath: CritPath,
  at?: number,
  toParentIndex?: number, // used to preserve index when moving into a criteria node
): Query {
  // get and remove from 'from parent' node:
  const nodeId = fromPath.at(-1);
  let nodeToMove: CriteriaNode | undefined;
  query = deleteNode(query, fromPath, (deletedNode) => {
    nodeToMove = deletedNode;
  });
  if (!nodeToMove) {
    return query;
  }
  const newNodeToMove: CriteriaNode = { ...nodeToMove };
  // insert into 'to parent' node:
  query = insertNode(
    query,
    toPath,
    newNodeToMove,
    nodeId ?? (isCriteriaGroup(newNodeToMove) ? generateGroupId() : generateCriteriaId()),
    at,
    toParentIndex,
  );
  return query;
}

export function moveNodeByIndexPath(
  query: Query,
  fromIndexPath: CritIndexPath,
  toIndexPath: CritIndexPath,
): Query {
  if (fromIndexPath.length === 0 || toIndexPath.length === 0) {
    return query;
  }
  const fromPath = getPathByIndexPath(query, fromIndexPath);
  // ignore last index since it is the 'at' argument
  const toPath = getPathByIndexPath(query, toIndexPath.slice(0, -1));
  if (!fromPath || !toPath) {
    return query;
  }
  const at = toIndexPath[toIndexPath.length - 1];
  const parentIndex = toIndexPath[toIndexPath.length - 2];
  return moveNode(query, fromPath, toPath, at, parentIndex);
}

export function appendCriteriaByIndexPath(
  query: Query,
  criteria: Criteria,
  toIndexPath?: CritIndexPath,
) {
  const toPath = toIndexPath ? getPathByIndexPath(query, toIndexPath) : undefined;
  const critCompId = generateCriteriaId();
  if (!toPath || !toIndexPath) {
    return { ...query, children: new Map(query.children.set(critCompId, criteria)) };
  } else {
    const parentIndex = toIndexPath[toIndexPath.length - 1];
    return insertNode(query, toPath, criteria, critCompId, undefined, parentIndex);
  }
}

export function parseIndexPath(pathStr: string): CritIndexPath {
  if (pathStr === '') {
    return [];
  }
  return pathStr.split('.').map((i) => parseInt(i, 10));
}
