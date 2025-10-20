import { IReactionDisposer, action, computed, makeObservable, observable, reaction } from 'mobx';

import { MAX_TAG_DEPTH } from '../../../common/config';
import { ID } from '../../api/id';
import { ROOT_TAG_ID, TagDTO } from '../../api/tag';
import TagStore from '../stores/TagStore';
import { normalizeBase } from 'common/core';

/**
 * A Tag as it is stored in the Client.
 * It is stored in a MobX store, which can observe changed made to it and subsequently
 * update the entity in the backend.
 */
export class ClientTag {
  private store: TagStore;
  private saveHandler: IReactionDisposer;
  private aliasesHandler: IReactionDisposer;

  readonly id: ID;
  readonly dateAdded: Date;
  @observable name: string;
  @observable color: string;
  @observable isHidden: boolean;
  /** Whether a tag is marked as Visible when inherited */
  @observable isVisibleInherited: boolean;
  @observable private _parent: ClientTag | undefined;
  readonly subTags = observable<ClientTag>([]);
  @observable private readonly _impliedByTags = observable<ClientTag>([]);
  @observable private readonly _impliedTags = observable<ClientTag>([]);
  @observable isHeader: boolean;
  @observable description: string;
  readonly aliases = observable<string>([]);
  /** Index of the latest matched alias.
   * It cannot be observable because currently we update it while rendering tag selectors */
  aliasMatchIndex: number = -1;

  // Not observable but lighter and good enough for quick sorting in the UI.
  // Gets recalculated when TagStore.tagList is recomputed.
  flatIndex: number = 0;

  // icon, (fileCount?)

  /** The amount of files that have this tag implicitly assigned to them.
   *
   * Note: we are using a computed to automatically calculate this value recursively whenever
   * any part of this tag's sub hierarchy or assignments changes. This could get really
   * expensive really quickly, but since we are only reading this value in the tagsTree labels
   * (which is virtualized), we get great benefits from it because only visible tags need to calculate this.
   *
   * However, if in the future we need to read a tag's fileCount or impliedAssignedFiles continuously
   * in a large set of tags, we might need to refactor this if it doesn't perform well enough.
   */
  @computed get fileCount(): number {
    return this.impliedAssignedFiles.size;
  }
  /** Set of the file IDs that have explicitly assigned this tag */
  readonly assignedFiles = observable(new Set<ID>());
  /** Set of the file IDs that have implicitly assigned this tag */
  @computed get impliedAssignedFiles(): Set<ID> {
    const impliedAssignedFiles = new Set<ID>(this.assignedFiles);
    for (const subTag of this.getImpliedSubTree()) {
      for (const fileId of subTag.assignedFiles) {
        impliedAssignedFiles.add(fileId);
      }
    }
    return impliedAssignedFiles;
  }

  constructor(store: TagStore, tagProps: TagDTO) {
    this.store = store;
    this.id = tagProps.id;
    this.dateAdded = tagProps.dateAdded;
    this.name = tagProps.name;
    this.color = tagProps.color;
    this.isHidden = tagProps.isHidden;
    this.isVisibleInherited = tagProps.isVisibleInherited;
    this.isHeader = tagProps.isHeader;
    this.description = tagProps.description;
    this.aliases.replace(tagProps.aliases);

    // observe normalizedAliases and normalizedName in a reaction to keep alive the computed cache.
    this.aliasesHandler = reaction(
      () => [this.normalizedAliases, this.normalizedName],
      () => {},
    );

    // observe all changes to observable fields
    this.saveHandler = reaction(
      // We need to explicitly define which values this reaction should react to
      () => this.serialize(),
      // Then update the entity in the database
      (tag) => {
        this.store.save(tag);
      },
      { delay: 500 },
    );

    makeObservable(this);
  }

  /** Get a number reference which changes if its sub hierarchy is updated */
  @computed get subtreeVersion(): number {
    for (let i = 0; i < this.subTags.length; i++) {
      // Touch dependencies explicitly
      this.subTags[i].subtreeVersion;
    }
    return performance.now();
  }

  /** Get actual tag objects based on the IDs retrieved from the backend */
  @computed get parent(): ClientTag {
    if (this._parent === undefined) {
      console.warn('Tag does not have a parent', this);
      return this.store.root;
    }
    return this._parent;
  }

  initImpliedTags(impliedTagIds: ID[]): void {
    if (this._impliedTags.length > 0) {
      return;
    }
    for (const id of impliedTagIds) {
      const impliedTag = this.store.get(id);
      if (impliedTag !== undefined) {
        this._impliedTags.push(impliedTag);
        impliedTag._impliedByTags.push(this);
      }
    }
  }

  /** Get actual "implied by" tag objects based on the IDs retrieved from the backend */
  @computed get impliedByTags(): ClientTag[] {
    return this._impliedByTags.slice();
  }

  /** Get actual "implied" tag objects based on the IDs retrieved from the backend */
  @computed get impliedTags(): ClientTag[] {
    return this._impliedTags.slice();
  }

  /** Returns this tag and all of its sub-tags ordered depth-first */
  @action getSubTree(): Generator<ClientTag> {
    function* tree(
      tag: ClientTag,
      depth: number,
      visited = new Set<ClientTag>(),
      path = new Set<ClientTag>(),
    ): Generator<ClientTag> {
      if (path.has(tag) && tag.id !== ROOT_TAG_ID) {
        tag.store.showTagToast(
          tag,
          'has circular relations with other tags',
          'tag-cicle-err',
          'error',
        );
        console.error(`Tag "${tag.name}" has circular relations with other tags`, tag);
      } else if (depth > MAX_TAG_DEPTH) {
        console.error('Subtree has too many tags. Maximum tag depth exceeded', tag);
        return;
      } else if (!visited.has(tag)) {
        path.add(tag);
        visited.add(tag);
        yield tag;
        for (const subTag of tag.subTags) {
          yield* tree(subTag, depth + 1, visited, path);
        }
        path.delete(tag);
      }
    }
    return tree(this, 0);
  }

  /** Returns this tag and all of its "implied By" sub-tags and their sub-tags ordered depth-first */
  @action getImpliedSubTree(): Generator<ClientTag> {
    function* tree(
      tag: ClientTag,
      depth: number,
      visited = new Set<ClientTag>(),
      path = new Set<ClientTag>(),
    ): Generator<ClientTag> {
      if (path.has(tag) && tag.id !== ROOT_TAG_ID) {
        tag.store.showTagToast(
          tag,
          'has circular implied relations with other tags',
          'tag-cicle-err',
          'error',
        );
        console.error(`Tag "${tag.name}" has circular implied relations with other tags`, tag);
      } else if (depth > MAX_TAG_DEPTH) {
        console.error('Subtree has too many tags. Maximum tag depth exceeded', tag);
      } else if (!visited.has(tag)) {
        path.add(tag);
        visited.add(tag);
        yield tag;
        for (const subTag of tag.subTags) {
          yield* tree(subTag, depth + 1, visited, path);
        }
        for (const subTag of tag._impliedByTags) {
          yield* tree(subTag, depth + 1, visited, path);
        }
        path.delete(tag);
      }
    }
    return tree(this, 0);
  }

  /**
   * Returns this tag and all its ancestors (excluding root tag).
   * @param visited Accepts an optional visited set to avoid redundant traversal across multiple calls (when resolving ancestors for many tags).
   */
  @action getAncestors(visited?: Set<ClientTag>): Generator<ClientTag> {
    function* ancestors(
      tag: ClientTag,
      depth: number,
      visited = new Set<ClientTag>(),
      path = new Set<ClientTag>(),
    ): Generator<ClientTag> {
      if (path.has(tag)) {
        tag.store.showTagToast(
          tag,
          'has circular relations with other tags',
          'tag-cicle-err',
          'error',
        );
        console.error(`Tag "${tag.name}" has circular relations with other tags`, tag);
      } else if (depth > MAX_TAG_DEPTH) {
        console.error('Tag has too many ancestors. Maximum tag depth exceeded', tag);
      } else if (tag.id !== ROOT_TAG_ID && !visited.has(tag)) {
        path.add(tag);
        visited.add(tag);
        yield tag;
        yield* ancestors(tag.parent, depth + 1, visited, path);
        path.delete(tag);
      }
    }
    return ancestors(this, 0, visited);
  }

  /**
   * Returns this tag and all its implied ancestors (excluding root tag).
   * @param visited Accepts an optional visited set to avoid redundant traversal across multiple calls (when resolving ancestors for many tags).
   */
  @action getImpliedAncestors(visited?: Set<ClientTag>): Generator<ClientTag> {
    function* ancestors(
      tag: ClientTag,
      depth: number,
      visited = new Set<ClientTag>(),
      path = new Set<ClientTag>(),
    ): Generator<ClientTag> {
      if (path.has(tag)) {
        tag.store.showTagToast(
          tag,
          'has circular implied relations with other tags',
          'tag-cicle-err',
          'error',
        );
        console.error(`Tag "${tag.name}" has circular implied relations with other tags`, tag);
      } else if (depth > MAX_TAG_DEPTH) {
        console.error('Tag has too many ancestors. Maximum tag depth exceeded', tag);
      } else if (tag.id !== ROOT_TAG_ID && !visited.has(tag)) {
        path.add(tag);
        visited.add(tag);
        yield tag;
        yield* ancestors(tag.parent, depth + 1, visited, path);
        for (const impliedTag of tag._impliedTags) {
          yield* ancestors(impliedTag, depth + 1, visited, path);
        }
        path.delete(tag);
      }
    }
    return ancestors(this, 0, visited);
  }

  @computed get impliedAncestors(): ClientTag[] {
    const arr = [];
    for (const val of this.getImpliedAncestors()) {
      arr.push(val);
    }
    return arr;
  }

  /** Returns the tags up the hierarchy from this tag, excluding the root tag */
  @computed get path(): string[] {
    return Array.from(this.getAncestors(), (t) => `${t.isHeader ? '#' : ''}${t.name}`).reverse();
  }

  @computed get pathCharLength(): number {
    let total = 0;
    for (let i = 0; i < this.path.length; i++) {
      total += this.path[i].length;
    }
    return total;
  }

  get isSelected(): boolean {
    return this.store.isSelected(this);
  }

  @computed get viewColor(): string {
    for (const tag of this.getAncestors()) {
      if (tag.color !== 'inherit') {
        return tag.color;
      }
    }
    return this.store.root.color;
  }

  @computed get isSearched(): boolean {
    return this.store.isSearched(this);
  }

  /**
   * Returns true if tag is an ancestor of this tag.
   * @param tag possible ancestor node
   */
  @action isAncestor(tag: ClientTag): boolean {
    if (this === tag) {
      return false;
    }
    for (const ancestor of this.parent.getAncestors()) {
      if (ancestor === tag) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true if tag is an implied ancestor of this tag.
   * @param tag possible ancestor node
   */
  @action isImpliedAncestor(tag: ClientTag): boolean {
    if (this === tag) {
      return false;
    }
    for (const ancestor of this.getImpliedAncestors()) {
      if (ancestor === tag) {
        return true;
      }
    }
    return false;
  }

  @action setParent(parent: ClientTag): void {
    this._parent = parent;
  }

  @action.bound rename(name: string): void {
    this.name = name;
  }

  @action.bound setDescription(value: string): void {
    this.description = value;
  }

  @action.bound setColor(color: string): void {
    this.color = color;
  }

  @action.bound addAlias(alias: string): void {
    if (!this.aliases.includes(alias)) {
      this.aliases.push(alias);
    }
  }

  @action.bound setAlias(alias: string, index: number): void {
    this.aliases.splice(index, 1, alias);
  }

  @action.bound removeAlias(index: number): void {
    this.aliases.splice(index, 1);
  }

  @computed get normalizedAliases(): Set<string> {
    return new Set<string>(this.aliases.map((a) => normalizeBase(a)));
  }

  @computed get normalizedName(): string {
    return normalizeBase(this.name);
  }

  /**
   * Checks if the given value matches the tag's name or any of its aliases.
   * @param normalizedValue - The already normalized string to check against the tag's normalized name and aliases (it must be normalized beforehand to work properly).
   * @returns - Match indicator: 1 = exact match, 2 = substring match, 0 = no match.
   */
  @action.bound isMatch(normalizedValue: string): 0 | 1 | 2 {
    let index = -1;
    let result: 0 | 1 | 2 = 0;
    // First check if the value is equals to the name
    if (this.normalizedName === normalizedValue) {
      result = 1;
      // else check if the value is equals to any alias
    } else if (this.normalizedAliases.has(normalizedValue)) {
      // if there is an exact match find the index of the alias.
      result = 1;
      index = 0;
      for (const normalizedAlias of this.normalizedAliases) {
        if (normalizedAlias === normalizedValue) {
          break;
        }
        index++;
      }
      // else check if the values is a sub-string of the name
    } else if (this.normalizedName.includes(normalizedValue)) {
      result = 2;
      // else try to find if value is a sub-string of any alias.
    } else {
      index = 0;
      for (const normalizedAlias of this.normalizedAliases) {
        if (normalizedAlias.includes(normalizedValue)) {
          result = 2;
          break;
        }
        index++;
        // if no matching alias is found index will be set outside the range of this.aliases
      }
    }

    this.aliasMatchIndex = index;

    return result;
  }

  /**
   * moves the matched alias to the front of the array.
   * This helps speed up future match checks by keeping recently matched aliases at the top.
   */
  @action.bound shiftAliasToFront(): void {
    let index = this.aliasMatchIndex;
    if (index > 0 && index < this.aliases.length) {
      const aliasToMove = this.aliases[index];
      for (; index > 0; index--) {
        this.aliases[index] = this.aliases[index - 1];
      }
      this.aliases[0] = aliasToMove;
      this.aliasMatchIndex = 0;
    }
  }

  get matchName(): string {
    if (this.aliasMatchIndex >= 0 && this.aliasMatchIndex < this.aliases.length) {
      return `${this.aliases.at(this.aliasMatchIndex)} → ${this.name}`;
    }
    return this.name;
  }

  @action.bound insertSubTag(tag: ClientTag, at: number): boolean {
    let errorMsg = undefined;
    if (this === tag || tag.id === ROOT_TAG_ID) {
      errorMsg = 'cannot be inserted into itself.';
    } else if (this.isAncestor(tag)) {
      errorMsg = 'cannot be inserted into one of its own sub-tags.';
    } else if (this.isImpliedAncestor(tag)) {
      errorMsg = 'cannot be inserted into another that already implies it.';
    }
    if (errorMsg) {
      this.store.showTagToast(tag, errorMsg, 'tag-insert-err', 'error', 6000);
      return false;
    }

    // Move to different pos in same parent: Reorder tag.subTags and return
    if (this === tag.parent) {
      const currentIndex = this.subTags.indexOf(tag);
      if (currentIndex !== at && at >= 0 && at <= this.subTags.length) {
        // If moving below current position, take into account removing self affecting the index
        const newIndex = currentIndex < at ? at - 1 : at;
        this.subTags.remove(tag);
        this.subTags.splice(newIndex, 0, tag);
      }
    } else {
      // Insert subTag into tag
      tag.parent.subTags.remove(tag);
      if (at >= 0 && at < this.subTags.length) {
        this.subTags.splice(at, 0, tag);
      } else {
        this.subTags.push(tag);
      }
      tag.setParent(this);
    }
    return true;
  }

  @action.bound replaceImpliedTags(newTags: ClientTag[]): void {
    //convert to set for efficient comparison and avoid duplicates
    const newTagsSet = new Set(newTags);

    for (const tag of this._impliedTags.slice()) {
      if (!newTagsSet.has(tag)) {
        this.removeImpliedTag(tag);
      }
    }

    for (const tag of newTagsSet) {
      if (!this._impliedTags.includes(tag)) {
        this.addImpliedTag(tag);
        this.store.addRecentlyUsedTag(tag);
      }
    }
  }

  @action.bound replaceImpliedByTags(newTags: ClientTag[]): void {
    //convert to set for efficient comparison and avoid duplicates
    const newTagsSet = new Set(newTags);

    for (const tag of this._impliedByTags.slice()) {
      if (!newTagsSet.has(tag)) {
        tag.removeImpliedTag(this);
      }
    }

    for (const tag of newTagsSet) {
      if (!this._impliedByTags.includes(tag)) {
        tag.addImpliedTag(this);
        this.store.addRecentlyUsedTag(tag);
      }
    }
  }

  @action.bound addImpliedTag(tag: ClientTag): boolean {
    let errorMsg = '';
    if (this === tag || tag.id === ROOT_TAG_ID) {
      errorMsg = 'cannot imply itself.';
    } else if (tag.isImpliedAncestor(this)) {
      errorMsg = `cannot imply a tag that already implies "${this.name}" (would create a circular relation).`;
    } else if (this.isImpliedAncestor(tag)) {
      errorMsg = `already implies the "${tag.name}" tag. (possibly through an inherited implication)`;
    }
    if (errorMsg) {
      this.store.showTagToast(this, errorMsg, 'tag-imply-err', 'error', 6000);
      return false;
    }

    if (!this._impliedTags.includes(tag)) {
      this._impliedTags.push(tag);
      tag._impliedByTags.push(this);
    }
    return true;
  }

  @action.bound addImpliedByTag(tag: ClientTag): void {
    tag.addImpliedTag(this);
  }

  @action.bound removeImpliedTag(tag: ClientTag): void {
    const index = this._impliedTags.indexOf(tag);
    const impliedBy_index = tag._impliedByTags.indexOf(this);
    if (index !== -1) {
      this._impliedTags.splice(index, 1);
    }
    if (impliedBy_index !== -1) {
      tag._impliedByTags.splice(impliedBy_index, 1);
    }
  }

  @action.bound removeImpliedByTag(tag: ClientTag): void {
    tag.removeImpliedTag(this);
  }

  @action.bound incrementFileCount(files: ID | ID[]): void {
    if (Array.isArray(files)) {
      for (let i = 0; i < files.length; i++) {
        this.assignedFiles.add(files[i]);
      }
    } else {
      this.assignedFiles.add(files);
    }
  }

  @action.bound decrementFileCount(files: ID | ID[]): void {
    if (Array.isArray(files)) {
      for (let i = 0; i < files.length; i++) {
        this.assignedFiles.delete(files[i]);
      }
    } else {
      this.assignedFiles.delete(files);
    }
  }

  @action.bound toggleHidden(): void {
    this.isHidden = !this.isHidden;
    this.store.refetchFiles();
  }

  @action.bound toggleHeader(): void {
    this.isHeader = !this.isHeader;
  }

  @action.bound setVisibleInherited(val: boolean): void {
    this.isVisibleInherited = val;
  }

  /**
   * Similar to this.isVisibleInherited but
   * takes into account inheritedTagsVisibilityMode from UiStore
   */
  @computed get shouldShowWhenInherited(): boolean {
    return this.store.shouldShowWhenInherited(this);
  }

  serialize(): TagDTO {
    return {
      id: this.id,
      name: this.name,
      dateAdded: this.dateAdded,
      color: this.color,
      subTags: this.subTags.map((subTag) => subTag.id),
      isHidden: this.isHidden,
      impliedTags: this._impliedTags.map((impliedTag) => impliedTag.id),
      isVisibleInherited: this.isVisibleInherited,
      aliases: this.aliases.slice(),
      description: this.description,
      isHeader: this.isHeader,
    };
  }

  async delete(): Promise<void> {
    return this.store.delete(this);
  }

  dispose(): void {
    // clean up the observers
    this.aliasesHandler();
    this.saveHandler();
  }
}
