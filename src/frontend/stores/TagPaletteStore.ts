import { action, computed, makeObservable, observable, runInAction } from 'mobx';

import { DataStorage } from '../../api/data-storage';
import { generateId, ID } from '../../api/id';
import { TagPaletteDTO } from 'src/api/tagPalette';
import { ClientTag } from '../entities/Tag';
import RootStore from './RootStore';
import { ClientTagPalette } from '../entities/TagPalette';

export class TagPaletteStore {
  private readonly backend: DataStorage;
  private readonly rootStore: RootStore;

  private readonly palettesMap = observable(new Map<ID, ClientTagPalette>());

  @observable activePallete: ClientTagPalette | undefined;

  constructor(backend: DataStorage, rootStore: RootStore) {
    this.backend = backend;
    this.rootStore = rootStore;

    makeObservable(this);
  }

  async init(): Promise<void> {
    try {
      const fetchedPalettes = await this.backend.fetchTagPalettes();
      fetchedPalettes.sort((a, b) => a.index - b.index);
      runInAction(() => {
        for (const dto of fetchedPalettes) {
          const palette = new ClientTagPalette(this, dto);
          this.palettesMap.set(palette.id, palette);
        }
      });
    } catch (err) {
      console.error('Could not load tag palettes', err);
    }
  }

  resolveTags(tagIds: ID[]): ClientTag[] {
    return tagIds
      .map((id) => this.rootStore.tagStore.get(id))
      .filter((tag): tag is ClientTag => tag !== undefined);
  }

  @action get(id: ID): ClientTagPalette | undefined {
    return this.palettesMap.get(id);
  }

  @action.bound findIndex(id: ID): number {
    const pallete = this.palettesMap.get(id);
    if (pallete) {
      return pallete.index;
    }
    return -1;
  }

  @computed get paletteList(): readonly ClientTagPalette[] {
    return Array.from(this.palettesMap.values()).sort((a, b) => a.index - b.index);
  }

  @computed get count(): number {
    return this.palettesMap.size;
  }

  @computed get isEmpty(): boolean {
    return this.count === 0;
  }

  @action.bound async createPalette(name: string): Promise<ClientTagPalette> {
    const id = generateId();
    const newPaletteDto: TagPaletteDTO = {
      id,
      name,
      index: this.count, // Appends it to the end of the lists
      tags: [],
    };

    const palette = new ClientTagPalette(this, newPaletteDto);

    this.palettesMap.set(palette.id, palette);
    await this.backend.createTagPalette(palette.serialize());
    return palette;
  }

  @action.bound reorderPalette(paletteToMove: ClientTagPalette, targetIndex: number): void {
    const currentList = [...this.paletteList];
    const currentIndex = currentList.findIndex((p) => p.id === paletteToMove.id);
    if (
      currentIndex === -1 ||
      targetIndex < 0 ||
      targetIndex >= currentList.length ||
      currentIndex === targetIndex
    ) {
      return;
    }
    currentList.splice(currentIndex, 1);
    currentList.splice(targetIndex, 0, paletteToMove);
    currentList.forEach((palette, idx) => {
      if (palette.index !== idx) {
        palette.index = idx;
      }
    });
  }

  @action.bound async deletePalette(palette: ClientTagPalette): Promise<void> {
    this.palettesMap.delete(palette.id);
    palette.dispose();
    await this.backend.removeTagPalettes([palette.id]);
    this.normalizePaletteIndices();
  }

  @action.bound setActivePallete(pallete: ClientTagPalette | undefined): void {
    this.activePallete = pallete;
  }

  save(paletteDto: TagPaletteDTO): void {
    this.backend.saveTagPalette(paletteDto);
  }

  @action private normalizePaletteIndices(): void {
    let indexCounter = 0;
    for (const palette of this.paletteList) {
      palette.index = indexCounter++;
    }
  }
}

export default TagPaletteStore;
