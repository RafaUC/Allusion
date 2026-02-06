import { action, computed, makeObservable, observable, runInAction } from 'mobx';

import { DataStorage, makeFileBatchFetcher } from '../../api/data-storage';
import { generateId, ID } from '../../api/id';
import { ROOT_TAG_ID, TagDTO } from '../../api/tag';
import { ClientTagSearchCriteria } from '../entities/SearchCriteria';
import { ClientTag } from '../entities/Tag';
import RootStore from './RootStore';
import { AppToaster, IToastProps } from '../components/Toaster';
import { FileDTO } from 'src/api/file';
import { normalizeBase } from 'common/core';
import { ConditionGroupDTO } from 'src/api/data-storage-search';
import { debounce } from 'common/timeout';
import { batchReducer } from 'common/promise';

/**
 * Based on https://mobx.js.org/best/store.html
 */
class TagStore {
  private readonly backend: DataStorage;
  private readonly rootStore: RootStore;

  /** A lookup map to speedup finding entities */
  private dirtyTags = new Set<ClientTag>();
  private readonly tagGraph = observable(new Map<ID, ClientTag>());
  @observable fileCountsInitialized = false;

  debouncedSetDirtyTagsFileCountDirty: () => void;

  constructor(backend: DataStorage, rootStore: RootStore) {
    this.backend = backend;
    this.rootStore = rootStore;

    makeObservable(this);

    this.debouncedSetDirtyTagsFileCountDirty = debounce(this.setDirtyTagsFileCountDirty, 1000).bind(
      this,
    );
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

  setFileCountDirty(tag: ClientTag): void {
    this.dirtyTags.add(tag);
    this.debouncedSetDirtyTagsFileCountDirty();
  }

  /** Marks the dirtyTags and their implied ancestors as dirty. */
  @action.bound private setDirtyTagsFileCountDirty() {
    const visited = new Set<ClientTag>();
    for (const tag of this.dirtyTags) {
      if (tag.id === ROOT_TAG_ID) {
        return;
      }
      for (const impliedAncestor of tag.getImpliedAncestors(visited)) {
        impliedAncestor.setIsFileCountDirty(true);
      }
      tag.setIsFileCountDirty(true);
    }
    this.dirtyTags.clear();
  }

  private isUpdatingCounts = false;
  @action.bound async updateTagSubTreeFileCounts(tag: ClientTag): Promise<void> {
    if (this.isUpdatingCounts) {
      return;
    }
    this.isUpdatingCounts = true;
    const toastID = 'updateFilecounts';
    const totalStep = 4;
    let cancelled = false;
    const isCancelled = () => cancelled;
    const showProgressToast = (step: number, totalTags: number, processed: number) => {
      AppToaster.show(
        {
          message: `Updating file counts for ${totalTags} tags: step ${step}/${totalStep}${
            processed > 0 ? ` - ${((processed / totalTags) * 100).toFixed(1)}%...` : '...'
          }`,
          clickAction: { label: 'Cancel', onClick: () => (cancelled = true) },
          type: 'info',
          timeout: 5000,
        },
        toastID,
      );
    };

    showProgressToast(1, 1, 0);
    const criteria: ConditionGroupDTO<FileDTO> = {
      conjunction: 'and',
      children: [
        new ClientTagSearchCriteria(undefined, 'tags', tag.id, 'containsRecursively').toCondition(
          this.rootStore,
        ),
      ],
    };

    // Initialize tagfile sets, we will only compute counts for the implied sub tree of the initial tag
    const tagFileSets = new Map<string, Set<string>>();
    for (const impliedsubTag of tag.getImpliedSubTree()) {
      tagFileSets.set(impliedsubTag.id, new Set<string>());
    }

    showProgressToast(2, tagFileSets.size, 0);
    // fetch and add each file id to their respective assigned tag file sets in batches
    const batchSize = 1000;
    let batchCount = 0;
    await batchReducer(
      makeFileBatchFetcher(this.backend, batchSize, criteria),
      async (batch) => {
        batchCount++;
        batch.forEach((file) => {
          for (const tagId of file.tags) {
            tagFileSets.get(tagId)?.add(file.id);
          }
        });
        showProgressToast(2, tagFileSets.size, batchCount);
        return undefined;
      },
      undefined,
      isCancelled,
    );

    showProgressToast(3, tagFileSets.size, 0);
    if (!isCancelled()) {
      // compute merged sets
      const visited = new Set<string>();
      this.computeMergedTagFileSets(tag.id, tagFileSets, visited);
    }

    // update counts
    let count = 0;
    for (const [tagId, fileSet] of tagFileSets) {
      if (isCancelled()) {
        break;
      }
      count++;
      showProgressToast(4, tagFileSets.size, count);
      await runInAction(async () => {
        const clientTag = this.tagGraph.get(tagId);
        if (clientTag) {
          clientTag.setFileCount(fileSet.size);
          clientTag.setIsFileCountDirty(false);
          // Although client files save themselves, await a save anyway to prevent filling the stack with promises.
          // but this has very poor performance, although this operation will not be used too often.
          // TODO: Create a bulk tag save method.
          await this.save(clientTag.serialize());
        }
      });
    }
    // Hide toast
    AppToaster.show({ message: '', timeout: 1 }, toastID);
    this.isUpdatingCounts = false;
  }

  @action private computeMergedTagFileSets(
    tagId: string,
    tagFileSets: Map<string, Set<string>>,
    visited: Set<string>,
  ): Set<string> {
    const currentTag = this.tagGraph.get(tagId);
    const currentSet = tagFileSets.get(tagId);
    // avoid cicles
    if (visited.has(tagId) || !currentSet || !currentTag) {
      return currentSet || new Set();
    }
    visited.add(tagId);

    // Merge the sum of the subtags sets of the processing tag into its set recursively.
    for (const subtag of [...currentTag.subTags, ...currentTag.impliedByTags]) {
      if (tagFileSets.has(subtag.id)) {
        const subtagSet = this.computeMergedTagFileSets(subtag.id, tagFileSets, visited);
        for (const fileId of subtagSet) {
          currentSet.add(fileId);
        }
      }
    }

    return currentSet;
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
      fileCount: 0,
      isFileCountDirty: true,
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

  async save(tag: TagDTO): Promise<void> {
    await this.backend.saveTag(tag);
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
