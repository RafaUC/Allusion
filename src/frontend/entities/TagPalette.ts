import {
  IObservableArray,
  action,
  IReactionDisposer,
  makeObservable,
  observable,
  reaction,
} from 'mobx';

import { ID } from '../../api/id';
import { ClientTag } from './Tag';
import { TagPaletteDTO } from 'src/api/tagPalette';
import TagPaletteStore from '../stores/TagPaletteStore';

/**
 * Represents a TagPalette object in the client-side MobX store.
 */
export class ClientTagPalette {
  private store: TagPaletteStore;
  private saveHandler: IReactionDisposer;

  readonly id: ID;
  @observable name: string = '';
  @observable index: number;

  /** An ordered array of client tag instances belonging to this palette (can contain duplicates) */
  readonly tags: IObservableArray<ClientTag>;

  constructor(store: TagPaletteStore, paletteProps: TagPaletteDTO) {
    this.store = store;
    this.id = paletteProps.id;
    this.name = paletteProps.name;
    this.index = paletteProps.index;

    this.tags = observable(store.resolveTags(paletteProps.tags));

    makeObservable(this);

    // Observe all changes to observable fields and structure to trigger auto-save
    this.saveHandler = reaction(
      () => this.serialize(),
      (serializedPalette) => {
        this.store.save(serializedPalette);
      },
      { delay: 500 },
    );
  }

  @action.bound rename(name: string): void {
    this.name = name;
  }

  @action.bound clearTags(): void {
    this.tags.replace([]);
  }

  @action.bound addTag(tag: ClientTag): void {
    this.tags.push(tag);
  }

  /**
   * Moves a specific tag instance from a source index to a destination index.
   * This natively supports duplicate tags since it relies on array indices.
   */
  @action.bound moveTagAt(fromIndex: number, toIndex: number): boolean {
    if (
      fromIndex < 0 ||
      fromIndex >= this.tags.length ||
      toIndex < 0 ||
      toIndex > this.tags.length ||
      fromIndex === toIndex
    ) {
      return false;
    }
    const [tagToMove] = this.tags.splice(fromIndex, 1);
    // If moving forward, the extraction shifts the items back, so adjust target index
    const targetIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
    this.tags.splice(targetIndex, 0, tagToMove);
    return true;
  }

  @action.bound moveTagsSelectionByIndices(
    selectedIndices: Set<number>,
    targetIndex: number,
  ): void {
    const itemsToMove = this.tags.filter((_, idx) => selectedIndices.has(idx));
    const remainingItems = this.tags.filter((_, idx) => !selectedIndices.has(idx));
    const selectedBeforeTarget = Array.from(selectedIndices).filter(
      (idx) => idx < targetIndex,
    ).length;
    const realTargetIndex = Math.max(0, targetIndex - selectedBeforeTarget);
    const newOrder = [...remainingItems];
    newOrder.splice(realTargetIndex, 0, ...itemsToMove);
    this.tags.replace(newOrder);
  }

  /**
   * Removes all occurrences of a specific tag reference from the palette.
   */
  @action.bound removeTagAllOccurrences(tag: ClientTag): void {
    const filtered = this.tags.filter((t) => t !== tag);
    this.tags.replace(filtered);
  }

  /**
   * Removes a specific tag from the palette based on its unique position index.
   */
  @action.bound removeTagAt(index: number): boolean {
    if (index >= 0 && index < this.tags.length) {
      this.tags.splice(index, 1);
      return true;
    }
    return false;
  }

  async delete(): Promise<void> {
    return this.store.deletePalette(this);
  }

  serialize(): TagPaletteDTO {
    return {
      id: this.id,
      name: this.name,
      index: this.index,
      tags: this.tags.map((tag) => tag.id),
    };
  }

  dispose(): void {
    this.saveHandler();
  }
}
