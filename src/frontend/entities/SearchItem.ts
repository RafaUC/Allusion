import { action, computed, IObservableArray, makeObservable, observable } from 'mobx';

import { FileSearchDTO, SearchGroupDTO } from '../../api/file-search';
import { generateId, ID } from '../../api/id';
import { SearchCriteria } from '../../api/search-criteria';
import RootStore from '../stores/RootStore';
import {
  ClientFileSearchCriteria,
  ClientTagSearchCriteria,
  SearchConjuctionSymbols,
  SearchKeyDict,
} from './SearchCriteria';
import { ConditionGroupDTO, SearchConjunction } from 'src/api/data-storage-search';
import { FileDTO } from 'src/api/file';

export class ClientFileSearchItem {
  id: ID;
  @observable name: string = '';
  @observable rootGroup: ClientSearchGroup;

  /** A custom index defined by the user for ordering the search items */
  index: number = 0;

  // TODO: also store sort mode? (filename, descending, etc)
  // Then it wouldn't be a "Saved Search", but a "Saved view" maybe?

  constructor(id: ID, name: string, rootGroup: SearchGroupDTO, index: number) {
    this.id = id;
    this.name = name;
    this.rootGroup = ClientSearchGroup.deserialize(rootGroup);
    this.index = index;

    makeObservable(this);
  }

  @action.bound setName(value: string): void {
    this.name = value;
    this.rootGroup.name = value;
  }

  @action.bound setRootGroup(newRoot: ClientSearchGroup): void {
    this.rootGroup = newRoot;
  }

  @action.bound setIndex(newIndex: number): void {
    this.index = newIndex;
  }

  serialize(rootStore: RootStore): FileSearchDTO {
    return {
      id: this.id,
      name: this.name,
      rootGroup: this.rootGroup.serialize(rootStore),
      index: this.index,
    };
  }
}

export class ClientSearchGroup {
  id: ID;
  @observable name: string;
  @observable conjunction: SearchConjunction;
  readonly children: IObservableArray<ClientSearchGroup | ClientFileSearchCriteria>;
  @observable private _parent: ClientSearchGroup | undefined;

  constructor(
    id: ID,
    name: string,
    conjunction: SearchConjunction,
    children: Array<SearchGroupDTO | SearchCriteria>,
  ) {
    this.id = id;
    this.name = name;
    this.conjunction = conjunction;

    this.children = observable(
      children.map((c) => {
        if ('children' in c) {
          const g = ClientSearchGroup.deserialize(c);
          g.setParent(this);
          return g;
        }
        const crit = ClientFileSearchCriteria.deserialize(c);
        crit.setParent(this);
        return crit;
      }),
    );
    makeObservable(this);
  }

  static deserialize(group: SearchGroupDTO): ClientSearchGroup {
    return new ClientSearchGroup(group.id, group.name, group.conjunction, group.children);
  }

  @computed get parent(): ClientSearchGroup | undefined {
    return this._parent;
  }

  @action.bound
  setParent(parent?: ClientSearchGroup): void {
    this._parent = parent;
  }

  /** Checks if this group is somewhere inside other's subtree */
  @action.bound isAncestorOf(node: ClientSearchGroup): boolean {
    let current = node.parent;
    while (current) {
      if (current === this) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  /** Deep search by id */
  @action.bound containsNode(targetId: ID): boolean {
    if (this.id === targetId) {
      return true;
    }

    for (const ch of this.children) {
      if (ch.id === targetId) {
        return true;
      }
      if (isClientSearchGroup(ch) && ch.containsNode(targetId)) {
        return true;
      }
    }

    return false;
  }

  /** Removes a child node (only direct children) */
  @action.bound private removeChild(node: ClientSearchGroup | ClientFileSearchCriteria): boolean {
    const index = this.children.indexOf(node);
    if (index !== -1) {
      this.children.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Insert or move a node into targetId group
   */
  @action.bound insertNode(
    targetId: ID,
    newNode: ClientSearchGroup | ClientFileSearchCriteria,
    at?: number,
  ): boolean {
    // Found target
    if (this.id === targetId) {
      if (isClientSearchGroup(newNode) && newNode.containsNode(this.id)) {
        console.error('Insert prevented: cyclic structure detected');
        return false;
      }

      // Already in same parent → just reorder
      if (newNode.parent === this) {
        return this.moveWithinParent(newNode, at);
      }
      // Remove from previous parent
      if (newNode.parent) {
        newNode.parent.removeChild(newNode);
      }
      // Insert into this
      if (at !== undefined && at >= 0 && at <= this.children.length) {
        this.children.splice(at, 0, newNode);
      } else {
        this.children.push(newNode);
      }
      newNode.setParent(this);
      return true;
    }
    // Recurse into children
    for (const child of this.children) {
      if (isClientSearchGroup(child)) {
        const inserted = child.insertNode(targetId, newNode, at);
        if (inserted) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Reorder node inside same parent
   */
  @action.bound moveWithinParent(
    node: ClientSearchGroup | ClientFileSearchCriteria,
    at?: number,
  ): boolean {
    if (node.parent !== this) {
      return false;
    }
    const currentIndex = this.children.indexOf(node);
    if (currentIndex === -1) {
      return false;
    }
    let target = at ?? this.children.length - 1;
    if (target < 0) {
      target = 0;
    }
    if (target > this.children.length) {
      target = this.children.length;
    }
    if (target === currentIndex) {
      return true;
    }
    const newIndex = currentIndex < target ? target - 1 : target;
    this.children.splice(currentIndex, 1);
    this.children.splice(newIndex, 0, node);

    return true;
  }

  /**
   * Remove any node by id (deep search)
   */
  @action.bound removeNode(targetId: ID): boolean {
    const directIndex = this.children.findIndex((n) => n.id === targetId);
    if (directIndex !== -1) {
      const node = this.children[directIndex];
      this.children.splice(directIndex, 1);
      node.setParent(undefined);
      return true;
    }

    for (const child of this.children) {
      if (isClientSearchGroup(child)) {
        const removed = child.removeNode(targetId);
        if (removed) {
          return true;
        }
      }
    }

    return false;
  }

  serialize(rootStore: RootStore, duplicate = false, visited = new Set<ID>()): SearchGroupDTO {
    visited.add(this.id);
    const children = this.children
      .filter((ch) => !visited.has(ch.id)) // avoid cicles
      .map((ch) => ch.serialize(rootStore, duplicate, visited));
    return {
      id: duplicate ? generateId() : this.id,
      name: this.name,
      conjunction: this.conjunction,
      children,
    };
  }

  toCondition(rootStore: RootStore): ConditionGroupDTO<FileDTO> {
    return this.serialize(rootStore) as ConditionGroupDTO<FileDTO>;
  }

  getLabels(
    dict: SearchKeyDict,
    rootStore: RootStore,
    visited = new Set<ID>(),
  ): { id: ID; label: string; isSystemTag: boolean }[] {
    visited.add(this.id);
    const children = this.children
      .filter((ch) => !visited.has(ch.id)) // avoid cicles
      .flatMap((ch) => {
        if (isClientSearchGroup(ch)) {
          return ch.name && ch.name !== ''
            ? {
                id: ch.id,
                label: `${SearchConjuctionSymbols[this.conjunction]} ${ch.name}`,
                isSystemTag: false,
              }
            : ch.getLabels(dict, rootStore, visited);
        } else {
          return {
            id: ch.id,
            label: `${SearchConjuctionSymbols[this.conjunction]} ${ch.getLabel(dict, rootStore)}`,
            isSystemTag: ch instanceof ClientTagSearchCriteria && ch.isSystemTag(),
          };
        }
      });
    return children;
  }

  @action.bound dispose(): void {
    this.children.forEach((ch) => ch.dispose());
    this._parent = undefined;
  }
}

export function isClientSearchGroup(
  node: ClientSearchGroup | ClientFileSearchCriteria | object,
): node is ClientSearchGroup {
  return node instanceof ClientSearchGroup;
}
