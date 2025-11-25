import { action, computed, makeObservable, observable, runInAction } from 'mobx';

import { DataStorage } from '../../api/data-storage';
import { generateId, ID } from '../../api/id';
import { ROOT_TAG_ID, TagDTO } from '../../api/tag';
import { ClientTagSearchCriteria } from '../entities/SearchCriteria';
import { ClientTag } from '../entities/Tag';
import RootStore from './RootStore';
import { AppToaster, IToastProps } from '../components/Toaster';
import { FileDTO } from 'src/api/file';
import { normalizeBase } from 'common/core';
import { OrderDirection } from 'src/api/data-storage-search';

/**
 * Based on https://mobx.js.org/best/store.html
 */
class TagStore {
  private readonly backend: DataStorage;
  private readonly rootStore: RootStore;

  /** A lookup map to speedup finding entities */
  private readonly tagGraph = observable(new Map<ID, ClientTag>());
  @observable fileCountsInitialized = false;

  constructor(backend: DataStorage, rootStore: RootStore) {
    this.backend = backend;
    this.rootStore = rootStore;

    makeObservable(this);
  }

  async init(): Promise<void> {
    try {
      const fetchedTags = await this.backend.fetchTags();
      this.createTagGraph(fetchedTags);
      this.fixStrayTags();
    } catch (err) {
      console.log('Could not load tags', err);
    }
  }

  @action.bound async initializeFileCounts(allDbFiles?: FileDTO[]): Promise<void> {
    if (this.fileCountsInitialized) {
      return;
    }
    this.fileCountsInitialized = true;
    const files = allDbFiles ?? (await this.backend.fetchFiles('id', OrderDirection.Asc, false));
    for (const file of files) {
      for (const tagID of file.tags) {
        const tag = this.get(tagID);
        tag?.incrementFileCount(file.id);
      }
    }
  }

  @action get(tag: ID): ClientTag | undefined {
    return this.tagGraph.get(tag);
  }

  @action getTags(ids: ID[]): Set<ClientTag> {
    const tags = new Set<ClientTag>();
    for (const id of ids) {
      const tag = this.get(id);
      if (tag !== undefined) {
        tags.add(tag);
      }
    }
    return tags;
  }

  addRecentlyUsedTag(tag: ClientTag): void {
    this.rootStore.uiStore.addRecentlyUsedTag(tag);
  }

  @computed get root(): ClientTag {
    const root = this.tagGraph.get(ROOT_TAG_ID);
    if (!root) {
      throw new Error('Root tag not found. This should not happen!');
    }
    return root;
  }

  @computed get tagList(): readonly ClientTag[] {
    function* list(tags: ClientTag[]): Generator<ClientTag> {
      for (const tag of tags) {
        yield* tag.getSubTree();
      }
    }
    return Array.from(list(this.root.subTags), (tag, index) => {
      tag.flatIndex = index;
      return tag;
    });
  }

  @computed get count(): number {
    return this.tagList.length;
  }

  @computed get isEmpty(): boolean {
    return this.count === 0;
  }

  @action findFlatTagListIndex(target: ClientTag): number | undefined {
    const index = this.tagList.indexOf(target);
    return index > -1 ? index : undefined;
  }

  @action isSelected(tag: ClientTag): boolean {
    return this.rootStore.uiStore.tagSelection.has(tag);
  }

  isSearched(tag: ClientTag): boolean {
    return this.rootStore.uiStore.searchCriteriaList.some(
      (c) => c instanceof ClientTagSearchCriteria && c.value === tag.id,
    );
  }

  @action.bound async create(parent: ClientTag, tagName: string): Promise<ClientTag> {
    const id = generateId();
    const tag = new ClientTag(this, {
      id: id,
      name: tagName,
      aliases: [],
      description: '',
      dateAdded: new Date(),
      color: 'inherit',
      isHeader: false,
      isHidden: false,
      isVisibleInherited: true,
      impliedTags: [],
      subTags: [],
    });
    this.tagGraph.set(tag.id, tag);
    tag.setParent(parent);
    parent.subTags.push(tag);
    await this.backend.createTag(tag.serialize());
    return tag;
  }

  @action findByNameOrAlias(name: string): ClientTag | undefined {
    const normalizedName = normalizeBase(name);
    return this.tagList.find((t) => t.isMatch(normalizedName) === 1);
  }

  /**
   * Computes a reusable and concise callback function used by all tags
   * to determine if they should be visible on inheritance, based on the
   * inheritedTagsVisibilityMode from UiStore.
   *
   * This avoids having each tag perform all the condition checks on every reaction.
   */
  @computed get shouldShowWhenInherited(): (tag: ClientTag) => boolean {
    switch (this.rootStore.uiStore.inheritedTagsVisibilityMode) {
      case 'all':
        return () => true;
      case 'visible-when-inherited':
        return (tag: ClientTag) => tag.isVisibleInherited;
      default:
        return () => false;
    }
  }

  @action.bound async delete(tag: ClientTag): Promise<void> {
    const {
      rootStore: { uiStore, fileStore },
      tagGraph,
    } = this;
    const ids: ID[] = [];
    tag.parent.subTags.remove(tag);
    for (const t of tag.impliedByTags.slice()) {
      t.removeImpliedTag(tag);
    }
    for (const t of tag.impliedTags.slice()) {
      tag.removeImpliedTag(t);
    }
    for (const t of tag.getSubTree()) {
      t.dispose();
      tagGraph.delete(t.id);
      uiStore.deselectTag(t);
      ids.push(t.id);
    }
    await this.backend.removeTags(ids);
    uiStore.clearTagClipboard();
    fileStore.refetch();
  }

  @action.bound async deleteTags(tags: ClientTag[]): Promise<void> {
    const {
      rootStore: { uiStore, fileStore },
      tagGraph,
    } = this;
    const ids: ID[] = [];
    const remove = action((tag: ClientTag): ID[] => {
      tag.parent.subTags.remove(tag);
      for (const t of tag.impliedByTags.slice()) {
        t.removeImpliedTag(tag);
      }
      for (const t of tag.impliedTags.slice()) {
        tag.removeImpliedTag(t);
      }
      for (const t of tag.getSubTree()) {
        t.dispose();
        tagGraph.delete(t.id);
        uiStore.deselectTag(t);
        ids.push(t.id);
      }
      return ids.splice(0, ids.length);
    });
    for (const tag of tags) {
      await this.backend.removeTags(remove(tag));
    }
    uiStore.clearTagClipboard();
    fileStore.refetch();
  }

  @action.bound async merge(
    tagToBeRemoved: ClientTag,
    tagToMergeWith: ClientTag,
    addRemovedAsAliases: boolean = false,
  ): Promise<void> {
    // not dealing with tags that have subtags
    if (tagToBeRemoved.subTags.length > 0) {
      throw new Error('Merging a tag with sub-tags is currently not supported.');
    }
    if (addRemovedAsAliases) {
      tagToMergeWith.addAlias(tagToBeRemoved.name);
      for (const alias of tagToBeRemoved.aliases) {
        tagToMergeWith.addAlias(alias);
      }
    }
    this.rootStore.uiStore.deselectTag(tagToBeRemoved);
    // move implied relationships
    for (const tag of tagToBeRemoved.impliedTags) {
      tagToMergeWith.addImpliedTag(tag);
      tagToBeRemoved.removeImpliedTag(tag);
    }
    for (const tag of tagToBeRemoved.impliedByTags) {
      tagToMergeWith.addImpliedByTag(tag);
      tagToBeRemoved.removeImpliedByTag(tag);
    }
    this.tagGraph.delete(tagToBeRemoved.id);
    tagToBeRemoved.parent.subTags.remove(tagToBeRemoved);
    await this.backend.mergeTags(tagToBeRemoved.id, tagToMergeWith.id);
    this.rootStore.fileStore.refetch();
  }

  @action.bound refetchFiles(): void {
    this.rootStore.fileStore.refetch();
  }

  save(tag: TagDTO): void {
    this.backend.saveTag(tag);
  }

  @action private createTagGraph(backendTags: TagDTO[]) {
    // Create tags
    for (const backendTag of backendTags) {
      // Create entity and set properties
      // We have to do this because JavaScript does not allow multiple constructor.
      const tag = new ClientTag(this, backendTag);
      // Add to index
      this.tagGraph.set(tag.id, tag);
    }

    // Set parent and add sub and implied tags
    for (const { id, subTags, impliedTags } of backendTags) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const tag = this.tagGraph.get(id)!;

      for (const id of subTags) {
        const subTag = this.get(id);
        if (subTag !== undefined) {
          subTag.setParent(tag);
          tag.subTags.push(subTag);
        }
      }

      tag.initImpliedTags(impliedTags);
    }
    this.root.setParent(this.root);
  }

  @action private fixStrayTags(): void {
    const verifiedTags = new Set<ClientTag>(this.tagList);
    verifiedTags.add(this.root);
    if (verifiedTags.size === this.tagGraph.size) {
      console.debug('No stray tags detected.');
      return;
    }

    console.debug('Stray tags detected, attempting to insert them into the root tag.');
    for (const [, tag] of this.tagGraph) {
      if (verifiedTags.has(tag)) {
        continue;
      }
      const ancestors = Array.from(tag.getAncestors());
      const subroot = ancestors.at(-1);
      if (subroot) {
        const subtree = Array.from(subroot.getSubTree());
        for (const subtag of subtree) {
          verifiedTags.add(subtag);
        }
      }

      if (subroot && !this.root.subTags.includes(subroot)) {
        this.root.subTags.push(subroot);
        subroot.setParent(this.root);
        console.warn(
          `Tag "${subroot.name}" was disconnected from the main tree and has been added under the root.`,
          subroot,
        );
        this.showTagToast(
          subroot,
          'was disconnected from the main tree and has been added under the root.',
          'stray-tag',
          'warning',
          20000,
        );
      } else {
        console.error(
          `Tag "${tag.name}" was disconnected from the main tree and could not be added under the root.`,
          tag,
        );
      }
    }
  }

  showTagToast(
    tag: ClientTag,
    context: string,
    toastId: string,
    type?: IToastProps['type'],
    timeout = 10000,
  ): void {
    if (tag.id === ROOT_TAG_ID) {
      return;
    }
    setTimeout(() => {
      runInAction(() => {
        AppToaster.show(
          {
            message: `Tag "${tag.name}" ( ${tag.path.join(' › ')} ) ${context}`,
            timeout: timeout,
            type: type,
          },
          `${toastId}-${tag.id}`,
        );
      });
    });
  }
}

export default TagStore;
