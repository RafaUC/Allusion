import fse from 'fs-extra';
import { action, computed, makeObservable, observable, runInAction } from 'mobx';
//import { setTimeout as delay } from 'node:timers/promises';

import { getThumbnailPath } from 'common/fs';
import { batchReducer, promiseAllLimit } from 'common/promise';
import { debounce } from 'common/timeout';
import { DataStorage, makeFileBatchFetcher } from '../../api/data-storage';
import {
  ConditionGroupDTO,
  Cursor,
  OrderBy,
  OrderDirection,
  PaginationDirection,
} from '../../api/data-storage-search';
import { FileDTO, IMG_EXTENSIONS_TYPE } from '../../api/file';
import { ID } from '../../api/id';
import { AppToaster, IToastProps } from '../components/Toaster';
import { ClientFile, mergeMovedFile } from '../entities/File';
import { ClientLocation } from '../entities/Location';
import {
  ClientFileSearchCriteria,
  ClientStringSearchCriteria,
  ClientTagSearchCriteria,
} from '../entities/SearchCriteria';
import { ClientTag } from '../entities/Tag';
import RootStore from './RootStore';
import { ClientExtraProperty } from '../entities/ExtraProperty';
import { Dimensions } from '@floating-ui/core';
import {
  detectExtraPropertyType,
  ExtraProperties,
  ExtraPropertyValue,
} from 'src/api/extraProperty';
import { InheritedTagsVisibilityModeType } from './UiStore';
import { clamp } from 'common/core';
import { RendererMessenger } from 'src/ipc/renderer';
import { serializeDate } from 'src/backend/schemaTypes';

export const FILE_STORAGE_KEY = 'Allusion_File';

type FetchArgs = [
  OrderBy<FileDTO>, //order
  OrderDirection, //fileOrder
  boolean, //useNaturalOrdering
  number, //limit
  PaginationDirection | undefined, //pagination
  Cursor | undefined, //cursor
  string, //extraPropertyID
];

/** These fields are stored and recovered when the application opens up */
type PersistentPreferenceFields =
  | 'orderDirection'
  | 'orderBy'
  | 'orderByExtraProperty'
  | 'isNaturalOrderingEnabled'
  | 'averageFetchTimes'
  | 'numTotalFiles'
  | 'dirtyTotalFiles'
  | 'numUntaggedFiles'
  | 'dirtyUntaggedFiles'
  | 'numMissingFiles'
  | 'dirtyMissingFiles';

export const enum Content {
  All,
  Missing,
  Untagged,
  Query,
}

const ContentLabels: Record<Content, string> = {
  [Content.All]: 'All',
  [Content.Missing]: 'Missing',
  [Content.Untagged]: 'Untagged',
  [Content.Query]: 'Query',
};

const PAGE_SIZE = 256;

class FileStore {
  private readonly backend: DataStorage;
  private readonly rootStore: RootStore;

  readonly fileList = observable<ClientFile | undefined>([]);
  /** Returns only the defined files from fileList */
  @computed get definedFiles(): ClientFile[] {
    return this.fileList.filter((clientFile): clientFile is ClientFile => !!clientFile);
  }
  /** Array that only contains the dimensions of the BackendFiles for faster masonry layout calculation */
  readonly fileDimensions = observable<Dimensions>([]);
  /**
   * The timestamp when the fileList expected layout was last modified.
   * Useful for in react component dependencies that need to trigger logic when the fileList changes
   */
  @observable fileListLastRefetch = new Date();
  /** A map of file ID to its index in the file list, for quick lookups by ID */
  private readonly index = new Map<ID, number>();

  private filesToSave: Map<ID, FileDTO> = new Map();
  private pendingSaves: number = 0;
  @observable isSaving: boolean = false;
  isTaggingWithService: boolean = false;
  /** The origin of the current files that are shown */
  @observable private content: Content = Content.All;
  @observable orderDirection: OrderDirection = OrderDirection.Desc;
  @observable orderBy: OrderBy<FileDTO> = 'dateAdded';
  @observable isNaturalOrderingEnabled: boolean = false;
  @observable orderByExtraProperty: ID = '';

  @observable numTotalFiles = 0;
  @observable dirtyTotalFiles = true;
  @observable numUntaggedFiles = 0;
  @observable dirtyUntaggedFiles = true;
  @observable numMissingFiles = 0;
  @observable dirtyMissingFiles = true;
  @observable numFilteredFiles = 0;
  @observable numLoadedFiles = 0;
  /**
   * ID pair for the current backend fetch task.
   * Helps identify if a new task has started and allows aborting previous ones.
   * - First element: fetch ID
   * - Second element: filesFromBackend ID, also indicathes the state of the fetch:
   *     if its 0 the fetch process as ended, if its 1 the fetch process is in course
   * */
  readonly fetchTaskIdPair = observable<[number, number]>([0, 0]);
  readonly averageFetchTimes = observable(new Map<string, number>([]));

  debouncedRefetch: () => void;
  debouncedSaveFilesToSave: () => Promise<void>;

  constructor(backend: DataStorage, rootStore: RootStore) {
    this.backend = backend;
    this.rootStore = rootStore;
    makeObservable(this);

    this.debouncedRefetch = debounce(this.refetch, 800).bind(this);
    this.debouncedSaveFilesToSave = debounce(this.saveFilesToSave, 200).bind(this);
    // reaction to keep updated properties "related" to fileList
  }

  @action.bound async readTagsFromSelectedFiles(): Promise<void> {
    return this.readTagsFromFiles(undefined, true);
  }

  @action.bound async readTagsFromFiles(_?: React.MouseEvent, onlySelected = false): Promise<void> {
    const toastKey = 'read-tags-from-file';
    try {
      const files = onlySelected
        ? Array.from(this.rootStore.uiStore.fileSelection)
        : this.fileList.slice();
      const numFiles = files.length;
      for (let i = 0; i < numFiles; i++) {
        AppToaster.show(
          {
            message: `Reading tags from files ${((100 * i) / numFiles).toFixed(0)}%...`,
            timeout: 0,
          },
          toastKey,
        );
        const file = files[i];
        if (!file) {
          continue;
        }

        const absolutePath = file.absolutePath;

        try {
          const tagsNameHierarchies = await this.rootStore.exifTool.readTags(absolutePath);

          // Now that we know the tag names in file metadata, add them to the files in Allusion
          // Main idea: Find matching tag with same name, otherwise, insert new
          //   for now, just match by the name at the bottom of the hierarchy

          const { tagStore } = this.rootStore;
          for (const tagHierarchy of tagsNameHierarchies) {
            const match = tagStore.findByNameOrAlias(tagHierarchy[tagHierarchy.length - 1]);
            if (match) {
              // If there is a match to the leaf tag, just add it to the file
              file.addTag(match);
            } else {
              // If there is no direct match to the leaf, insert it in the tag hierarchy: first check if any of its parents exist
              let curTag = tagStore.root;
              for (const nodeName of tagHierarchy) {
                const nodeMatch = tagStore.findByNameOrAlias(nodeName);
                if (nodeMatch) {
                  curTag = nodeMatch;
                } else {
                  curTag = await tagStore.create(curTag, nodeName);
                }
              }
              file.addTag(curTag);
            }
          }
        } catch (e) {
          console.error('Could not import tags for', absolutePath, e);
        }
        try {
          const xmpExtraProperties = await this.rootStore.exifTool.readExtraProperties(
            absolutePath,
          );
          if (!xmpExtraProperties) {
            continue;
          }
          const parsedProps = JSON.parse(xmpExtraProperties);
          const { extraPropertyStore } = this.rootStore;
          for (const [name, value] of Object.entries(parsedProps)) {
            const detectedType = detectExtraPropertyType(value);
            if (!detectedType) {
              console.warn(`Type not supported for extraProperty "${name}":`, typeof value);
              continue;
            }
            let match = extraPropertyStore.getByNameAndType(name, detectedType);
            if (!match) {
              match = await extraPropertyStore.createExtraProperty(name, detectedType);
            }
            file.setExtraProperty(match, value as ExtraPropertyValue);
          }
        } catch (e) {
          console.error('Could not import extraProperties for', absolutePath, e);
        }
      }
      AppToaster.show(
        {
          message: 'Reading tags from files... Done!',
          timeout: 5000,
        },
        toastKey,
      );
    } catch (e) {
      console.error('Could not read tags', e);
      AppToaster.show(
        {
          message: 'Reading tags from files failed. Check the dev console for more details',
          timeout: 5000,
        },
        toastKey,
      );
    }
  }

  @action.bound async writeTagsToSelectedFiles(): Promise<void> {
    return this.writeTagsToFiles(undefined, true);
  }

  @action.bound async writeTagsToFiles(_?: React.MouseEvent, onlySelected = false): Promise<void> {
    const toastKey = 'write-tags-to-file';
    try {
      const files = onlySelected
        ? Array.from(this.rootStore.uiStore.fileSelection)
        : this.definedFiles.slice();
      const numFiles = files.length;
      const fileTagsProps = runInAction(() =>
        files.map((f) => {
          const extraProps: Record<string, ExtraPropertyValue> = {};
          for (const [ep, value] of f.extraProperties) {
            extraProps[ep.name] = value;
          }
          return {
            absolutePath: f.absolutePath,
            tagHierarchy: Array.from(
              f.tags,
              action((t) => t.path),
            ),
            extraPropsValues: JSON.stringify(extraProps),
          };
        }),
      );
      let lastToastVal = '0';
      for (let i = 0; i < fileTagsProps.length; i++) {
        const newToastVal = ((100 * i) / numFiles).toFixed(0);
        if (lastToastVal !== newToastVal) {
          lastToastVal = newToastVal;
          AppToaster.show(
            {
              message: `Writing tags to files ${newToastVal}%...`,
              timeout: 0,
            },
            toastKey,
          );
        }

        const { absolutePath, tagHierarchy, extraPropsValues } = fileTagsProps[i];
        try {
          await this.rootStore.exifTool.writeTags(absolutePath, tagHierarchy, extraPropsValues);
        } catch (e) {
          console.error('Could not write tags to', absolutePath, tagHierarchy, e);
        }
      }
      AppToaster.show(
        {
          message: 'Writing tags to files... Done!',
          timeout: 5000,
        },
        toastKey,
      );
    } catch (e) {
      console.error('Could not write tags', e);
      AppToaster.show(
        {
          message: 'Writing tags to files failed. Check the dev console for more details',
          timeout: 5000,
        },
        toastKey,
      );
    }
  }

  @action.bound async tagFileUsingNamesOrAliases(file: ClientFile, tags: string[]): Promise<void> {
    const tagStore = this.rootStore.tagStore;
    const root = tagStore.root;
    const matches: ClientTag[] = [];
    for (const tag of tags) {
      let match = tagStore.findByNameOrAlias(tag);
      if (match === undefined) {
        match = await tagStore.create(root, tag);
      }
      // First collect all matches in an array instead of directly adding them to
      // the file, to avoid unnecessary backend saves while awaiting the creation of tags.
      matches.push(match);
    }
    file.addTags(matches);
  }

  @action.bound private async getTagNamesUsingTaggingService(file: ClientFile) {
    const taggingServiceURL = this.rootStore.uiStore.taggingServiceURL;
    const response = await fetch(taggingServiceURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: file.absolutePath }),
    }).catch((error) => {
      throw new Error(`Error while performing the request to the tagging service: ${error}`);
    });

    // Process the response. If there are errors, show them in the console.
    // but do not throw to allow the rest of the files to be processed.
    if (response.ok) {
      // successful request
      try {
        const responseData = await response.json();
        if (responseData.tags && Array.isArray(responseData.tags)) {
          const tagNames: string[] = responseData.tags
            .map((tag: any) => tag?.name)
            .filter((name: string | undefined): name is string => name !== undefined);
          if (tagNames.length === 0) {
            console.warn('Possible invalid tag data format: no "name" found.');
            return;
          }
          return tagNames;
        } else if (responseData.error) {
          console.error('Tagging service response error: ', responseData.error);
        } else {
          console.error(
            'Tagging service error: no tags found or invalid tag data format. ' +
              'The response must contain a "tags" key, containing a an array of objects, each with a "name" key.',
          );
        }
      } catch (error) {
        // catch .json() errors
        console.error(
          'Tagging service error: The response must be JSON containing' +
            ' a "tags" key, containing a an array of objects, each with a "name" key.',
          error,
        );
      }
    } else {
      let errorBody;
      try {
        errorBody = await response.clone().json();
      } catch {
        errorBody = await response.text();
      }
      console.error('Response error:', response.status, errorBody);
    }
  }

  @action.bound private async getAllowedFilesFromTaggingService(
    files: string[],
  ): Promise<Set<string> | undefined> {
    const taggingServiceURL = this.rootStore.uiStore.taggingServiceURL + '/allowed-files/';
    const response = await fetch(taggingServiceURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: files }),
    }).catch((error) => {
      throw new Error(`Error while requesting allowed files: ${error}`);
    });

    if (response.ok) {
      try {
        const responseData = await response.json();
        if (responseData.allowed && Array.isArray(responseData.allowed)) {
          const allowed = new Set<string>();
          responseData.allowed.forEach((path: unknown) => {
            if (typeof path === 'string') {
              allowed.add(path);
            }
          });
          return allowed;
        } else {
          console.error('Allowed files response error: no "allowed" key found.');
        }
      } catch (error) {
        console.error('Allowed files error: response must be JSON.', error);
      }
    } else {
      let errorBody;
      try {
        errorBody = await response.clone().json();
      } catch {
        errorBody = await response.text();
      }
      console.error('Allowed files request failed:', response.status, errorBody);
    }
  }

  @action.bound async tagSelectedFilesUsingTaggingService(): Promise<void> {
    if (this.isTaggingWithService) {
      return;
    }
    this.isTaggingWithService = true;
    const taggingServiceURL = this.rootStore.uiStore.taggingServiceURL;
    const isAllFilesSelected = this.rootStore.uiStore.isAllFilesSelected;
    const selectedFiles = Array.from(this.rootStore.uiStore.fileSelection);
    const selectedIndex = new Map(selectedFiles.map((f, i) => [f.id, i]));
    const N = this.rootStore.uiStore.taggingServiceParallelRequests;
    const batchSize = 25;
    const numFiles = isAllFilesSelected ? this.numFilteredFiles : selectedFiles.length;
    const toastKey = 'tagging-using-service';
    const isMulti = numFiles > 1;

    let count = 0;
    let successCount = 0;
    let isServiceActive = false;
    let isCancelled = false;
    const cancelled = () => isCancelled;
    const failedClickAction = { label: 'Open DevTools', onClick: RendererMessenger.toggleDevTools };

    // use local counters instead of using the progress argument of the callbacks
    const showProgressToaster = () => {
      if (!isCancelled) {
        const percentage = ((count / numFiles) * 100).toFixed(2);
        AppToaster.show(
          {
            message: `Tagging ${numFiles} file${isMulti ? 's ' : ''}${isMulti ? percentage : ''}${
              isMulti ? '%' : ''
            } (${count})...  ${successCount !== count ? `(${count - successCount} failures)` : ''}`,
            timeout: 0,
            clickAction: {
              label: 'Cancel',
              onClick: () => {
                isCancelled = true;
              },
            },
          },
          toastKey,
        );
      }
    };

    const showfinishToaster = () => {
      if (successCount === 0) {
        isCancelled = true;
        const message = taggingServiceURL
          ? 'Could not get tags from the tagging service: is it not running, or is the API/URL misconfigured?'
          : 'No Local Tagging Service API configured, go to: Settings > Background Processes > Local Tagging Service API URL';
        AppToaster.show(
          {
            type: 'error',
            message: message,
            timeout: 10000,
            clickAction: taggingServiceURL ? failedClickAction : undefined,
          },
          toastKey,
        );
      } else {
        const isSuccess = successCount === numFiles;
        AppToaster.show(
          {
            type: isSuccess ? 'success' : 'warning',
            message: `Successfully tagged ${successCount} of ${numFiles} files.  ${
              !isSuccess ? `(${numFiles - successCount} failures)` : ''
            }`,
            timeout: 0,
            clickAction: !isSuccess ? failedClickAction : undefined,
          },
          toastKey,
        );
      }
    };

    const processBatch = async (files: ClientFile[]) => {
      // Try to get the Allowed files, in case of the service API does some filtering to skip unnecessary requests
      const allowedFiles = await this.getAllowedFilesFromTaggingService(
        files.map((f) => f.absolutePath),
      ).catch((e) => console.error(e));
      files =
        allowedFiles === undefined ? files : files.filter((f) => allowedFiles.has(f.absolutePath));
      // Process files with only N jobs in parallel and a progress + cancel callback
      await promiseAllLimit(
        files.map((file, batchIndex) => async () => {
          // if the file was in the original selection use that instance instead
          // and replace the file in the batch with it (because the whole batch gets saved at the end
          // and if the unotuched instance gets saved, the changes made get lost)
          const idx = selectedIndex.get(file.id);
          if (idx !== undefined) {
            file = selectedFiles[idx];
            files[batchIndex] = file;
          }
          const currentSuccessCount = successCount;
          const generatedTagNames = await this.getTagNamesUsingTaggingService(file);
          if (!isCancelled && generatedTagNames !== undefined && generatedTagNames.length > 0) {
            try {
              await this.tagFileUsingNamesOrAliases(file, generatedTagNames);
              // Add a common tag to indicate that the file was auto-tagged, allowing the user to filter them.
              await this.tagFileUsingNamesOrAliases(file, ['auto-tagged']);
              // Save the file even if it has been disposed after a change of content view
              if (!file.isAutoSaveEnabled) {
                this.save(runInAction(() => file.serialize()));
              }
              successCount++;
            } catch (error) {
              console.error(error);
            }
          }
          // if not success, allways for the first one but do not spam if all are fails.
          if (successCount === currentSuccessCount && (!isServiceActive || successCount > 0)) {
            AppToaster.show(
              {
                type: 'error',
                message: `Failed to get the tags for "${file.name}" from the tagging service`,
                timeout: 8000,
                clickAction: failedClickAction,
              },
              `${toastKey}-failed-${file.id}`,
            );
          }
          count++;
          isServiceActive = true;
        }),
        N,
        showProgressToaster,
        cancelled,
      );
    };

    showProgressToaster();

    if (isAllFilesSelected) {
      await this.dispatchToFilteredFiles(
        processBatch,
        () => {},
        cancelled,
        showfinishToaster,
        batchSize,
      );
    } else {
      await processBatch(selectedFiles).catch((e) => console.error(e));
      showfinishToaster();
    }

    this.isTaggingWithService = false;
  }

  get InheritedTagsVisibilityMode(): InheritedTagsVisibilityModeType {
    return this.rootStore.uiStore.inheritedTagsVisibilityMode;
  }

  @action private setContent(content: Content): void {
    this.content = content;
    if (this.rootStore.uiStore.isSlideMode) {
      this.rootStore.uiStore.disableSlideMode();
    }
  }

  private setContentQuery(): void {
    this.setContent(Content.Query);
  }

  private setContentAll(): void {
    this.setContent(Content.All);
  }

  private setContentUntagged(): void {
    this.setContent(Content.Untagged);
  }

  private setContentMissing() {
    this.setContent(Content.Missing);
  }

  @computed get showsAllContent(): boolean {
    return this.content === Content.All;
  }

  @computed get showsUntaggedContent(): boolean {
    return this.content === Content.Untagged;
  }

  @computed get showsMissingContent(): boolean {
    return this.content === Content.Missing;
  }

  @computed get showsQueryContent(): boolean {
    return this.content === Content.Query;
  }

  @action.bound switchOrderDirection(): void {
    this.setOrderDirection(
      this.orderDirection === OrderDirection.Desc ? OrderDirection.Asc : OrderDirection.Desc,
    );
    this.refetch();
  }

  @action.bound toggleNaturalOrdering(): void {
    this.isNaturalOrderingEnabled = !this.isNaturalOrderingEnabled;
    this.refetch();
  }

  @action.bound orderFilesBy(prop: OrderBy<FileDTO> = 'dateAdded'): void {
    this.setOrderBy(prop);
    this.setOrderByExtraProperty('');
    this.refetch();
  }

  @action.bound orderFilesByExtraProperty(extraProperty: ClientExtraProperty): void {
    this.setOrderBy('extraProperty');
    this.setOrderByExtraProperty(extraProperty.id);
    this.refetch();
  }

  @computed get activeAverageFetchTimeKey(): string {
    const firstCiteria = this.rootStore.uiStore.searchCriteriaList[0] as
      | ClientFileSearchCriteria
      | undefined;
    const raw = firstCiteria?.toCondition(this.rootStore);
    const condition = Array.isArray(raw) ? raw[1] ?? raw[0] : raw;
    if (condition !== undefined && this.content === Content.Query) {
      // If the condition type needs 'where' or 'lambda' filters mixed in,
      // the fetch time varies depending on the operator
      if (condition.valueType === 'string' || condition.valueType === 'array') {
        return `${condition.valueType}-${condition.operator}`;
      } else {
        // The remaining types do not mix in 'lambda' or 'where' filters,
        // so a single average value is sufficient
        return `${condition.valueType}`;
      }
    } else {
      return `${this.content}`;
    }
  }

  @computed get activeAverageFetchTime(): number {
    return this.averageFetchTimes.get(this.activeAverageFetchTimeKey) ?? 5000;
  }

  @action.bound setAverageFetchTime(duration: number): void {
    const key = this.activeAverageFetchTimeKey;
    const prev = this.averageFetchTimes.get(key) ?? duration;
    const average = (prev + duration) / 2;
    this.averageFetchTimes.set(key, average);

    const format = (num: number) =>
      num.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const color1 = 'color: #4D88FF;';
    const color2 = 'color: #9980FF;';
    console.debug(
      `%cAdjusted average time for content "%c(${
        ContentLabels[this.content]
      }) ${key}%c": new: %c${format(duration)}ms%c, prev: %c${format(prev)}ms%c, avg: %c${format(
        average,
      )}ms`,
      // eslint-disable-next-line prettier/prettier
      color1,
      color2,
      color1,
      color2,
      color1,
      color2,
      color1,
      color2,
    );
  }

  @action.bound setNumLoadedFiles(val: number): void {
    this.numLoadedFiles = val;
  }

  @action.bound setDirtyTotalFiles(val: boolean): void {
    this.dirtyTotalFiles = val;
  }
  @action.bound setDirtyUntaggedFiles(val: boolean): void {
    this.dirtyUntaggedFiles = val;
  }
  @action.bound setDirtyMissingFiles(val: boolean): void {
    this.dirtyMissingFiles = val;
  }

  /**
   * Marks file as missing
   *
   * Marking a file as missing will remove the file from the FileStore stats and
   * automatically 'freezes' the object. Freezing means that changes made to a
   * file will not be saved in the database.
   * @param file
   */
  @action.bound hideFile(file: ClientFile): void {
    file.setBroken(true);
    this.rootStore.uiStore.deselectFile(file);
    this.incrementNumMissingFiles();
    if (file.tags.size === 0 && this.numUntaggedFiles > 0) {
      this.decrementNumUntaggedFiles();
    }
  }

  /** Replaces a file's data when it is moved or renamed */
  replaceMovedFile(file: ClientFile, newData: FileDTO): void;
  replaceMovedFile(id: string, newData: FileDTO): void;
  @action replaceMovedFile(fileOrId: ClientFile | string, newData: FileDTO): void {
    const file = typeof fileOrId === 'string' ? this.get(fileOrId) : fileOrId;
    const index = file !== undefined ? this.index.get(file.id) : undefined;
    if (index !== undefined && file !== undefined) {
      file.dispose();

      const newIFile = mergeMovedFile(file.serialize(), newData);

      // Move thumbnail
      const { thumbnailDirectory } = this.rootStore.uiStore; // TODO: make a config store for this?
      const oldThumbnailPath = file.thumbnailPath.split('?')[0];
      const newThumbPath = getThumbnailPath(newData.absolutePath, thumbnailDirectory);
      fse
        .move(oldThumbnailPath, newThumbPath)
        .catch((err) => console.error('Error moving file:', err));

      const newClientFile = new ClientFile(this, newIFile);
      newClientFile.thumbnailPath = newThumbPath;
      this.fileList[index] = newClientFile;
      this.save(newClientFile.serialize());
    }
  }

  /** Removes a file from the internal state of this store and the DB. Does not remove from disk. */
  @action async deleteFiles(files: ClientFile[]): Promise<void> {
    if (files.length === 0) {
      return;
    }

    try {
      // Remove from backend
      // Deleting non-exiting keys should not throw an error!
      await this.backend.removeFiles(files.map((f) => f.id));

      // Remove files from stores
      for (const file of files) {
        file.dispose();
        this.rootStore.uiStore.deselectFile(file);
        this.removeThumbnail(file.absolutePath);
      }
      runInAction(() => {
        this.replaceFileList(this.fileList.filter((f) => f && !files.includes(f)));
        this.dirtyMissingFiles = true;
      });
      return this.refetch();
    } catch (err) {
      console.error('Could not remove files', err);
    }
  }

  @action async deleteFilesByExtension(ext: IMG_EXTENSIONS_TYPE): Promise<void> {
    try {
      const crit = new ClientStringSearchCriteria(undefined, 'extension', ext, 'equals');
      const files = await this.backend.searchFiles(
        { conjunction: 'and', children: [crit.toCondition()] },
        'id',
        OrderDirection.Asc,
        false,
      );
      console.log('Files to delete', ext, files);
      await this.backend.removeFiles(files.map((f) => f.id));

      for (const file of files) {
        this.removeThumbnail(file.absolutePath);
      }
    } catch (e) {
      console.error('Could not delete files bye extension', ext);
    }
  }

  /**
   * Resets the number of loaded files and updates the first element
   * of `fetchTaskIdPair` with the current timestamp to uniquely identify the task.
   * @returns The generated fetch ID (timestamp)
   */
  @action.bound async newFetchTaskId(): Promise<number> {
    this.numLoadedFiles = 0;
    const now = performance.now();
    this.fetchTaskIdPair[0] = now;
    this.fetchTaskIdPair[1] = 1;
    /*
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!USE_BACKEND_AS_WORKER && this.activeAverageFetchTime > 2000) {
      // If the backend is not in a worker and the fetch is heavy
      // Apply a small delay to give time to the progressbar
      // to start the animation before the backend blocks the tread.
      await delay(600);
    } else {
      await delay(10);
    } */
    return now;
  }

  @action.bound async fetchPage(direction: PaginationDirection): Promise<void> {
    if (this.showsMissingContent) {
      return;
    }
    const { uiStore } = this.rootStore;
    const criterias = uiStore.searchRootGroup.toCondition(this.rootStore);
    try {
      // Indicate a new fetch process
      const start = await this.newFetchTaskId();
      const fetchedFiles = await this.backend.searchFiles(
        criterias,
        ...this.getFetchArgs(direction),
      );
      const end = performance.now();
      this.setAverageFetchTime(end - start);
      // continue if the current taskId is the same else abort the fetch
      const currentFetchId = runInAction(() => this.fetchTaskIdPair[0]);
      if (start === currentFetchId) {
        if (fetchedFiles.length === 0) {
          AppToaster.show(
            {
              message: `${direction === 'after' ? 'End' : 'Top'} of results reached`,
              timeout: direction === 'after' ? 5000 : 2000,
            },
            'results-edge-reached',
          );
        }
        return this.updateFromBackend(fetchedFiles, direction);
      } else {
        console.debug(`FETCH "${direction}" ABORTED`);
      }
    } catch (e) {
      console.log(`Could not fetch ${direction} page.`, e);
    }
  }

  @action.bound async fetchAfter(): Promise<void> {
    return this.fetchPage('after');
  }

  @action.bound async fetchBefore(): Promise<void> {
    return this.fetchPage('before');
  }

  @action.bound async refetch(): Promise<void> {
    if (this.showsAllContent) {
      return this.fetchAllFiles();
    } else if (this.showsUntaggedContent) {
      return this.fetchUntaggedFiles();
    } else if (this.showsQueryContent) {
      return this.fetchFilesByQuery();
    } else if (this.showsMissingContent) {
      return this.fetchMissingFiles();
    }
  }

  @action.bound toCursor(file: ClientFile | FileDTO): Cursor {
    let cursorValue: Cursor['orderValue'];
    if (this.orderBy === 'random') {
      cursorValue = null;
    } else if (this.orderBy === 'extraProperty') {
      const ep = this.rootStore.extraPropertyStore.get(this.orderByExtraProperty);
      if (file instanceof ClientFile) {
        cursorValue = ep ? file.extraProperties.get(ep) ?? null : null;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        cursorValue = ep ? file.extraProperties[ep.id] ?? null : null;
      }
    } else {
      const val = file[this.orderBy];
      if (val instanceof Date) {
        cursorValue = serializeDate(val);
      } else if (typeof val === 'object') {
        cursorValue = null;
      } else {
        cursorValue = val;
      }
    }
    return { id: file.id, orderValue: cursorValue };
  }

  @action.bound getFetchArgs(direction?: PaginationDirection): FetchArgs {
    let cursorItem: ClientFile | undefined;
    if (direction === 'after') {
      cursorItem = this.fileList.at(-1);
    } else if (direction == 'before') {
      cursorItem = this.fileList.at(0);
    } else {
      // Prioritize the first selected file.
      const selected = this.rootStore.uiStore.fileSelection.values().next().value as
        | ClientFile
        | undefined;
      if (selected) {
        cursorItem = selected;
        this.rootStore.uiStore.setFirstItem(cursorItem);
      } else {
        const firstId = this.rootStore.uiStore.firstItem?.id;
        cursorItem = firstId ? this.get(firstId) : undefined;
      }
    }
    let cursor: Cursor | undefined;
    if (!cursorItem) {
      cursor = this.rootStore.uiStore.firstItem
        ? { ...this.rootStore.uiStore.firstItem } // make a copy to remove observables
        : undefined;
    } else {
      cursor = this.toCursor(cursorItem);
    }

    return [
      this.orderBy,
      this.orderDirection,
      this.isNaturalOrderingEnabled,
      PAGE_SIZE, // 256, // limit
      direction ?? 'after', // pagination
      cursor, // cursor
      this.orderByExtraProperty,
    ];
  }

  @action.bound async initialFetch(criterias?: ConditionGroupDTO<FileDTO>): Promise<FileDTO[]> {
    const args: FetchArgs = this.getFetchArgs();
    // Split the initial pagination into two halves to place the first item in the
    // middle, avoids triggering multiple prepend/append operations on refetch,
    // which caused visual jumps.

    // Fetch the top half first.
    args[3] = Math.trunc(PAGE_SIZE / 2); // split page size
    args[4] = 'before';
    const topHalf = await this.backend.searchFiles(criterias, ...args);
    // bottom half
    args[4] = 'after';
    const bottomitem = topHalf.at(-1);
    // if no items returned by bottom half use the same cursor
    args[5] = bottomitem ? this.toCursor(bottomitem) : undefined;
    const bottomHalf = await this.backend.searchFiles(criterias, ...args);
    return topHalf.concat(bottomHalf);
  }

  @action.bound async fetchAllFiles(): Promise<void> {
    try {
      this.setContentAll();
      // Indicate a new fetch process
      const start = await this.newFetchTaskId();
      this.rootStore.uiStore.clearSearchCriteriaTree();
      const fetchedFiles = await this.initialFetch();
      const end = performance.now();
      this.setAverageFetchTime(end - start);
      // continue if the current taskId is the same else abort the fetch
      const currentFetchId = runInAction(() => this.fetchTaskIdPair[0]);
      if (start === currentFetchId) {
        return this.updateFromBackend(fetchedFiles);
      } else {
        console.debug('FETCH All ABORTED');
      }
    } catch (err) {
      console.error('Could not load all files', err);
    }
  }

  @action.bound async fetchUntaggedFiles(): Promise<void> {
    try {
      this.setContentUntagged();
      // Indicate a new fetch process
      const { uiStore } = this.rootStore;
      uiStore.clearSearchCriteriaTree();
      uiStore.searchRootGroup.children.push(new ClientTagSearchCriteria(undefined, 'tags'));
      const criterias = uiStore.searchRootGroup.toCondition(this.rootStore);
      const start = await this.newFetchTaskId();
      const fetchedFiles = await this.initialFetch(criterias);
      const end = performance.now();
      this.setAverageFetchTime(end - start);
      // continue if the current taskId is the same else abort the fetch
      const currentFetchId = runInAction(() => this.fetchTaskIdPair[0]);
      if (start === currentFetchId) {
        return this.updateFromBackend(fetchedFiles);
      } else {
        console.debug('FETCH UNTAGGED ABORTED');
      }
    } catch (err) {
      console.error('Could not load all files', err);
    }
  }

  @action.bound async fetchMissingFiles(): Promise<void> {
    try {
      const {
        rootStore: { uiStore },
      } = this;

      this.setContentMissing();
      uiStore.clearSearchCriteriaTree();

      const allMissingClientFiles = await this._fetchMissingFiles();

      runInAction(() => {
        this.replaceFileList(allMissingClientFiles);
        this.numMissingFiles = allMissingClientFiles.length;
        this.dirtyMissingFiles = false;
        this.fileListLastRefetch = new Date();
      });
      this.cleanFileSelection();

      AppToaster.show(
        {
          message:
            'Some files can no longer be found. Either move them back to their location, or delete them from Allusion',
          timeout: 12000,
        },
        'recovery-view',
      );
    } catch (err) {
      console.error('Could not load broken files', err);
    }
  }

  @action.bound async fetchFilesByQuery(): Promise<void> {
    const { uiStore } = this.rootStore;
    if (uiStore.searchRootGroup.children.length === 0) {
      return this.fetchAllFiles();
    }

    const criterias = uiStore.searchRootGroup.toCondition(this.rootStore);
    try {
      this.setContentQuery();
      // Indicate a new fetch process
      const start = await this.newFetchTaskId();
      const fetchedFiles = await this.initialFetch(criterias);
      const end = performance.now();
      this.setAverageFetchTime(end - start);
      // continue if the current taskId is the same else abort the fetch
      const currentFetchId = runInAction(() => this.fetchTaskIdPair[0]);
      if (start === currentFetchId) {
        return this.updateFromBackend(fetchedFiles);
      } else {
        console.debug('FETCH BY QUERY ABORTED');
      }
    } catch (e) {
      console.log('Could not find files based on criteria', e);
    }
  }

  @action.bound async jumpToFirst(): Promise<void> {
    //logic: set an empty cursor and do a refetch.
    this.rootStore.uiStore.clearFileSelection();
    this.rootStore.uiStore.clearFirstItem();
    await this.refetch();
  }

  @action.bound async jumpToLast(): Promise<void> {
    //logic: fetch the first file with the inverse order, then set it as cursor and refetch.
    const args = this.getFetchArgs();
    args[1] = this.orderDirection === OrderDirection.Asc ? OrderDirection.Desc : OrderDirection.Asc;
    args[3] = 2; // limit, needs to load the last two items because of how this.initialFetch works
    args[5] = undefined; // no cursor
    const criterias = this.rootStore.uiStore.searchRootGroup.toCondition(this.rootStore);
    const lastFile = (await this.backend.searchFiles(criterias, ...args)).at(-1);
    if (!lastFile) {
      return;
    }
    const lastClientFile = runInAction(() => new ClientFile(this, lastFile));
    lastClientFile.dispose();
    this.rootStore.uiStore.clearFileSelection();
    this.rootStore.uiStore.setFirstItem(lastClientFile);
    await this.refetch();
  }

  @action.bound incrementNumUntaggedFiles(): void {
    this.numUntaggedFiles++;
  }

  @action.bound decrementNumUntaggedFiles(): void {
    if (this.numUntaggedFiles === 0) {
      throw new Error('Invalid Database State: Cannot have less than 0 untagged files.');
    }
    this.numUntaggedFiles--;
  }

  // Removes all items from fileList
  @action.bound clearFileList(): void {
    for (const file of this.fileList) {
      file?.dispose();
    }
    this.numLoadedFiles = 0;
    this.fileDimensions.clear();
    this.fileList.clear();
    this.index.clear();
  }

  /**
   * Replaces the current file list with a new one and updates:
   * - Dimensions (defaulting to 100x100 if undefined)
   * - Index mapping from file ID to its position
   * - Count of loaded (defined) files
   */
  @action.bound replaceFileList(newFiles: (ClientFile | undefined)[]): void {
    this.index.clear();
    for (let index = 0; index < newFiles.length; index++) {
      const file = newFiles[index];
      if (file) {
        this.index.set(file.id, index);
      }
    }
    this.fileList.replace(newFiles);
    this.fileDimensions.replace(
      this.fileList.map((f) => ({
        width: f ? f.width : 100,
        height: f ? f.height : 100,
      })),
    );
    this.numLoadedFiles = this.definedFiles.length;
  }

  @action get(id: ID): ClientFile | undefined {
    const fileIndex = this.index.get(id);
    return fileIndex !== undefined ? this.fileList[fileIndex] : undefined;
  }

  getIndex(id: ID): number | undefined {
    return this.index.get(id);
  }

  getTags(ids: ID[]): Set<ClientTag> {
    return this.rootStore.tagStore.getTags(ids);
  }

  addRecentlyUsedTag(tag: ClientTag): void {
    this.rootStore.uiStore.addRecentlyUsedTag(tag);
    this.rootStore.tagStore.setFileCountDirty(tag);
  }

  getExtraProperties(
    dtoExtraProperties: ExtraProperties,
  ): Map<ClientExtraProperty, ExtraPropertyValue> {
    const extraProperties = new Map<ClientExtraProperty, ExtraPropertyValue>();
    for (const [id, value] of Object.entries(dtoExtraProperties)) {
      const clientProperty = this.rootStore.extraPropertyStore.get(id);
      if (clientProperty !== undefined) {
        extraProperties.set(clientProperty, value);
      }
    }
    return extraProperties;
  }

  getLocation(location: ID): ClientLocation {
    const loc = this.rootStore.locationStore.get(location);
    if (!loc) {
      this.backend.removeLocation(location);
      throw new Error(
        `Location of file was not found! This should never happen! Location ${location}`,
      );
    }
    return loc;
  }

  incrementPendingSaves(): void {
    this.pendingSaves++;
  }

  decrementPendingSaves(): void {
    if (this.pendingSaves === 0) {
      throw new Error('Invalid Database State: Cannot have less than 0 pending saves.');
    }
    this.pendingSaves--;
  }

  @action.bound setIsSaving(val: boolean): void {
    this.isSaving = val;
  }

  save(file: FileDTO): void {
    file.dateModified = new Date();

    // Save files in bulk so saving many files at once is faster.
    // Each file will call this save() method individually after detecting a change on its observable fields,
    // these can be batched by collecting the changes and debouncing the save operation
    this.filesToSave.set(file.id, file);
    this.debouncedSaveFilesToSave();
    this.setIsSaving(true);
  }

  private async saveFilesToSave() {
    this.incrementPendingSaves();
    const files = Array.from(this.filesToSave.values());
    this.filesToSave.clear();
    await this.backend.saveFiles(files);
    this.decrementPendingSaves();
    if (this.pendingSaves === 0) {
      this.setIsSaving(false);
    }
  }

  @action recoverPersistentPreferences(): void {
    const prefsString = localStorage.getItem(FILE_STORAGE_KEY);
    if (prefsString) {
      try {
        const prefs = JSON.parse(prefsString);
        // BACKWARDS_COMPATIBILITY: orderDirection used to be called fileOrder
        this.setOrderDirection(prefs.orderDirection ?? prefs.fileOrder);
        this.setOrderBy(prefs.orderBy);
        this.isNaturalOrderingEnabled = Boolean(prefs.isNaturalOrderingEnabled ?? false);
        if (prefs.orderByExtraProperty) {
          this.setOrderByExtraProperty(prefs.orderByExtraProperty);
        }
        if (prefs.averageFetchTimes) {
          this.averageFetchTimes.replace(new Map(prefs.averageFetchTimes));
        }
        if (prefs.numTotalFiles) {
          this.numTotalFiles = prefs.numTotalFiles;
        }
        if (prefs.numUntaggedFiles) {
          this.numUntaggedFiles = prefs.numUntaggedFiles;
        }
        if (prefs.numMissingFiles) {
          this.numMissingFiles = prefs.numMissingFiles;
        }
        this.dirtyTotalFiles = Boolean(prefs.dirtyTotalFiles ?? true);
        this.dirtyUntaggedFiles = Boolean(prefs.dirtyUntaggedFiles ?? true);
        this.dirtyMissingFiles = Boolean(prefs.dirtyMissingFiles ?? true);
        console.info('View recovered preferences:', prefs);
      } catch (e) {
        console.error('Cannot parse persistent preferences:', FILE_STORAGE_KEY, e);
      }
    }
  }

  getPersistentPreferences(): Partial<Record<keyof FileStore, unknown>> {
    const preferences: Record<PersistentPreferenceFields, unknown> = {
      orderBy: this.orderBy,
      orderDirection: this.orderDirection,
      isNaturalOrderingEnabled: this.isNaturalOrderingEnabled,
      orderByExtraProperty: this.orderByExtraProperty,
      averageFetchTimes: Array.from(this.averageFetchTimes.entries()),
      numTotalFiles: this.numTotalFiles,
      dirtyTotalFiles: this.dirtyTotalFiles,
      numUntaggedFiles: this.numUntaggedFiles,
      dirtyUntaggedFiles: this.dirtyUntaggedFiles,
      numMissingFiles: this.numMissingFiles,
      dirtyMissingFiles: this.dirtyMissingFiles,
    };
    return preferences;
  }

  clearPersistentPreferences(): void {
    localStorage.removeItem(FILE_STORAGE_KEY);
  }

  @action private async removeThumbnail(path: string) {
    const thumbnailPath = getThumbnailPath(path, this.rootStore.uiStore.thumbnailDirectory);
    try {
      if (await fse.pathExists(thumbnailPath)) {
        return fse.remove(thumbnailPath);
      }
    } catch (error) {
      // TODO: Show a notification that not all thumbnails could be removed?
      console.error(error);
    }
  }

  private async _fetchMissingFiles(count: true): Promise<number>;
  private async _fetchMissingFiles(count?: false): Promise<ClientFile[]>;
  @action private async _fetchMissingFiles(count: boolean = false): Promise<number | ClientFile[]> {
    // Fetch all files, then check their existence and only show the missing ones
    // Similar to {@link updateFromBackend}, but the existence check needs to be awaited before we can show the images
    // process all the backend files in batches

    // variables to compute progressbar's progress
    const total = this.numTotalFiles;
    const batchSize = 1000;
    const step = Math.ceil(total / 100);
    let batchNum = 0;

    // flag to indicate whether we should update the numLoadedFiles during the fetch
    // or ignore cancelations by new fetch tasks
    const isViewContent = this.showsMissingContent;
    // Indicate a new fetch process if needed
    const start = await this.newFetchTaskId();

    let cancelled = false;
    const isCancelled = () => cancelled;

    const allMissingClientFiles = await batchReducer(
      makeFileBatchFetcher(this.backend, batchSize),
      async (batch, acc) => {
        // continue if the current taskId is the same else abort the fetch
        const currentFetchId = runInAction(() => this.fetchTaskIdPair[0]);
        if (isViewContent && !(start === currentFetchId)) {
          console.debug('FETCH MISSING ABORTED');
          cancelled = true;
        }

        // For every new file coming in create a new clientfile
        // witout updating ovserbables and cancelling because this methos is sometimes in background
        const { newFiles, status } = await this.filesFromBackend(batch, false, true);
        if (status != Status.success) {
          cancelled = true;
        }

        // We don't store whether files are missing (since they might change at any time)
        // So we have to check all files and check their existence them here
        const existenceCheckPromises = runInAction(() => {
          const definedFiles = newFiles.filter(
            (clientFile): clientFile is ClientFile => !!clientFile,
          );
          const batchStart = batchNum * batchSize;

          return definedFiles.map((clientFile, i) => async () => {
            const exists = await fse.pathExists(clientFile.absolutePath);
            clientFile.setBroken(!exists);
            if (exists) {
              clientFile.dispose();
            }
            if (isViewContent && ((batchStart + i) % step === 0 || i === total - 1)) {
              this.setNumLoadedFiles(batchStart + i);
            }
          });
        });

        const N = 50; // TODO: same here as in fetchFromBackend: number of concurrent checks should be system dependent
        await promiseAllLimit(existenceCheckPromises, N);
        // If filesFromBackend was aborted or the user changed the content while checking for
        // missing files, do not replace the fileList
        const [content, currentFetchId2] = runInAction(() => [
          this.content,
          this.fetchTaskIdPair[0],
        ]);
        if (isViewContent && (content !== Content.Missing || !(start === currentFetchId2))) {
          console.debug('FETCH MISSING ABORTED');
          cancelled = true;
        }

        const missingClientFiles = runInAction(() =>
          newFiles.filter(
            (file): file is ClientFile => file !== undefined && file.isBroken === true,
          ),
        );

        batchNum++;
        return count
          ? (acc as number) + missingClientFiles.length
          : (acc as ClientFile[]).concat(missingClientFiles);
      },
      count ? 0 : ([] as ClientFile[]),
      isCancelled,
    );
    // this error should always be catched
    if (isCancelled()) {
      if (!count) {
        (allMissingClientFiles as ClientFile[]).forEach((f) => f.dispose);
      }
      throw new Error('FETCH MISSING ABORTED');
    }
    const end = performance.now();
    this.setAverageFetchTime(end - start);

    return allMissingClientFiles;
  }

  @action async updateFromBackend(
    backendFiles: FileDTO[],
    direction?: PaginationDirection,
  ): Promise<void> {
    const isReplace = direction === undefined;
    if (backendFiles.length === 0 && isReplace) {
      this.rootStore.uiStore.clearFileSelection();
      this.fileListLastRefetch = new Date();
      this.fetchTaskIdPair[1] = 0;
      this.updateFileCountsState();
      return this.clearFileList();
    }

    // Filter out images with hidden tags
    // TODO: could also do it in search query, this is simpler though (maybe also more performant)
    const hiddenTagIds = new Set(
      this.rootStore.tagStore.tagList.filter((t) => t.isHidden).map((t) => t.id),
    );
    backendFiles = backendFiles.filter((f) => !f.tags.some((t) => hiddenTagIds.has(t)));

    // For every new file coming in, either re-use the existing client file if it exists,
    // or construct a new client file
    const { status, newFiles } = await this.filesFromBackend(backendFiles, isReplace);
    if (status != Status.success) {
      return;
    }

    // if status == succes newfiles are all defined;
    const definedNewFiles = newFiles as ClientFile[];
    // Check existence of new files asynchronously, no need to wait until they can be shown
    // we can simply check whether they exist after they start rendering
    // TODO: We can already get this from chokidar (folder watching), pretty much for free
    const existenceCheckPromises = runInAction(() => {
      return definedNewFiles.map((clientFile) => async () => {
        const exists = await fse.pathExists(clientFile.absolutePath);
        clientFile.setBroken(!exists);
      });
    });

    runInAction(() => {
      if (direction === 'after') {
        // append
        this.replaceFileList([...this.fileList, ...definedNewFiles]);
      }
      if (direction === 'before') {
        // prepend
        this.replaceFileList([...definedNewFiles, ...this.fileList]);
      }
      if (isReplace) {
        this.replaceFileList(definedNewFiles);
        this.fileListLastRefetch = new Date();
        this.updateFileCountsState();
        this.cleanFileSelection();
      }
    });
    // Run the existence check with at most N checks in parallel
    // TODO: Should make N configurable, or determine based on the system/disk performance
    // NOTE: This is _not_ await intentionally, since we want to show the files to the user as soon as possible
    const N = 50;
    return promiseAllLimit(existenceCheckPromises, N)
      .then(() => {
        this.countLoadedMissingfiles(); // update missing image counter
      })
      .catch((e) => console.error('An error occured during existence checking!', e));
  }

  /** Remove files from selection that are not in the file list anymore */
  @action private cleanFileSelection() {
    const { fileSelection } = this.rootStore.uiStore;
    for (const file of fileSelection) {
      if (!this.index.has(file.id)) {
        fileSelection.delete(file);
      }
    }
  }

  /**
   * Populates "fileList" and "index" with backendFiles, reusing existing ClientFiles when possible,
   * else creating new ones and disposes unused files.
   *
   * Files are processed in prioritized batches, favoring the batch nearest to uiStore.firstItem
   *
   * @param backendFiles Array of files from the backend to process.
   * @param updateObservable If true, updates the `fileList` observable and `index`, if false, still disposes unused files.
   * @param batchSize Number of files to process per batch (default: 256).
   * @returns The processed file list, index and status result.
   */
  @action private async filesFromBackend(
    backendFiles: FileDTO[],
    updateObservable = true,
    ignoreCancel = false,
    batchSize = 256,
  ): Promise<{
    newFiles: (ClientFile | undefined)[];
    newIndex: Map<string, number>;
    status: Status;
  }> {
    // get current task Id and update the sub Id
    const taskId: [number, number] = [this.fetchTaskIdPair[0], performance.now()];
    this.fetchTaskIdPair[1] = taskId[1];
    const total = backendFiles.length;

    // Copy of the current fileList and index to process reused and dispose unused ClienFiles
    // if updateObservables is false use as reference the original observables to avoid creating unnecessary copies
    const transitionFileList = updateObservable ? this.fileList.slice() : this.fileList;
    const transitionIndex = updateObservable ? new Map(this.index) : this.index;
    const newArray = new Array<ClientFile | undefined>(total);
    const targetList = updateObservable ? this.fileList : newArray;
    const targeIndex = updateObservable ? this.index : new Map<string, number>();
    if (updateObservable) {
      this.fileList.replace(newArray);
      targeIndex.clear();
    }
    if (updateObservable) {
      this.numLoadedFiles = 0;
    }
    const reusedStatus = new Set<ID>();
    let status: Status = Status.success;
    const initialIndex = clamp(this.rootStore.uiStore.firstItemIndex, 0, total - 1);

    // Calculate number of Batches and its order, prioritizing batches closer to the initialIndex;
    // calculate the initial batch to process with initilIndex at his center.
    const initialBatchStart = initialIndex - Math.floor(batchSize / 2);
    const initialBatchIndex = Math.ceil(initialBatchStart / batchSize);
    // Absolute start of the batches, it can be negative because of the offset when centering the initialIndex
    // and it's used to calculate other batches with the offset
    const absoluteBatchStart = initialBatchStart - batchSize * initialBatchIndex;
    const totalBatches = Math.ceil((total - absoluteBatchStart) / batchSize);
    const batchOrder: number[] = [];
    for (let offset = 0; batchOrder.length < totalBatches; offset++) {
      const before = initialBatchIndex - offset;
      const after = initialBatchIndex + offset;
      if (offset === 0) {
        batchOrder.push(initialBatchIndex);
      } else {
        if (after < totalBatches) {
          batchOrder.push(after);
        }
        if (before >= 0) {
          batchOrder.push(before);
        }
      }
    }

    for (const batchIndex of batchOrder) {
      // calculate and truncate batch boundaries to valid array range
      const rawStart = absoluteBatchStart + batchIndex * batchSize;
      const start = Math.max(rawStart, 0);
      const end = Math.min(rawStart + batchSize - 1, total - 1);

      runInAction(() => {
        for (let i = start; i <= end; i++) {
          //Stop processing the batch if FFBETaskIds changed
          if (
            !ignoreCancel &&
            (taskId[0] !== this.fetchTaskIdPair[0] || taskId[1] !== this.fetchTaskIdPair[1])
          ) {
            status = Status.aborted;
            break;
          }
          const f = backendFiles[i];
          const idx = i;
          // Might already exist!
          // if ignoreCancel allways create new files
          const eFileIndex = !ignoreCancel ? transitionIndex.get(f.id) : undefined;
          const existingFile =
            eFileIndex !== undefined ? transitionFileList[eFileIndex] : undefined;
          if (existingFile) {
            reusedStatus.add(existingFile.id);
            // Update tags (might have changes, e.g. removed/merged)
            const newTags: ClientTag[] = [];
            for (const tagId of f.tags) {
              const tag = this.rootStore.tagStore.get(tagId);
              if (tag) {
                newTags.push(tag);
              }
            }
            if (
              existingFile.tags.size !== newTags.length ||
              Array.from(existingFile.tags).some((t, i) => t.id !== newTags[i].id)
            ) {
              existingFile.updateTagsFromBackend(newTags);
            }
            // Update extraProperties (might have changes, e.g. removed)
            const newExtraProps = new Map<ClientExtraProperty, ExtraPropertyValue>();
            for (const [id, value] of Object.entries(f.extraProperties)) {
              const clientExtraProp = this.rootStore.extraPropertyStore.get(id);
              if (clientExtraProp) {
                newExtraProps.set(clientExtraProp, value);
              }
            }
            if (
              existingFile.extraProperties.size !== newExtraProps.size ||
              Array.from(existingFile.extraProperties).some((t) => t[1] !== newExtraProps.get(t[0]))
            ) {
              existingFile.updateExtraPropertiesFromBackend(newExtraProps);
            }
            targetList[idx] = existingFile;
            targeIndex.set(existingFile.id, idx);
            if (updateObservable) {
              this.numLoadedFiles++;
            }
          } else {
            // Otherwise, create new one.
            // TODO: Maybe better performance by always keeping the same pool of client files,
            // and just replacing their properties instead of creating new objects
            // But that's micro optimization...
            const file = new ClientFile(this, f);
            // Initialize the thumbnail path so the image can be loaded immediately when it mounts.
            // To ensure the thumbnail actually exists, the `ensureThumbnail` function should be called
            runInAction(() => {
              file.setThumbnailPath(
                this.rootStore.imageLoader.needsThumbnail(f)
                  ? getThumbnailPath(f.absolutePath, this.rootStore.uiStore.thumbnailDirectory)
                  : f.absolutePath,
              );
            });
            targetList[idx] = file;
            targeIndex.set(file.id, idx);
            if (updateObservable) {
              this.numLoadedFiles++;
            }
          }
        }
      });
      //Stop processing all batches if this promise is aborted
      if (status.valueOf() === Status.aborted) {
        console.debug('FILES FROM BACKEND ABORTED');
        break;
      }

      // Wait to allow mobx reaction to complete and propagated changes to fileList and index
      // if initial batch wait more to ensure it's propagated before the next batch
      const delay = batchIndex === initialBatchIndex ? 500 : 0;
      await new Promise((r) => setTimeout(r, delay));
    }

    runInAction(() => {
      // Ensure numLoadedFiles is not bigger than the total of files, this can happen when
      // this funcion is called again before finishing or aborting the previous one.
      if (updateObservable && this.numLoadedFiles > targetList.length) {
        this.numLoadedFiles = targetList.length;
      }
      if (updateObservable) {
        // Dispose of Clientfiles that are not re-used (to get rid of MobX observers)
        for (const file of transitionFileList) {
          if (file && !reusedStatus.has(file.id)) {
            file.dispose();
          }
        }
      }
      // set task sub id as finished if not aborted
      if (!ignoreCancel && status.valueOf() !== Status.aborted) {
        this.fetchTaskIdPair[1] = 0;
      }
    });
    return { newFiles: targetList, newIndex: targeIndex, status: status };
  }

  @action private countLoadedMissingfiles() {
    // if found missing files while fetching files only overwrite numMissingfiles it when it's 0
    if (this.numMissingFiles > 0) {
      return;
    }
    let count = 0;
    this.fileList.forEach((f) => {
      if (f?.isBroken) {
        count++;
      }
    });
    this.numMissingFiles = count;
  }

  @action private async updateFileCountsState() {
    if (this.showsMissingContent) {
      // in case of showingMissing update the count in that fetch method
      return;
    }
    const { uiStore } = this.rootStore;
    // determine what counts to fetch based con content view.
    const withCriteria = !this.showsAllContent;
    const withFiles = !this.showsAllContent || this.dirtyTotalFiles;
    const withUntagged = this.showsAllContent && this.dirtyUntaggedFiles;
    const withMissing = this.showsAllContent && this.dirtyMissingFiles;

    const criteria = withCriteria ? uiStore.searchRootGroup.toCondition(this.rootStore) : undefined;
    const options = {
      files: withFiles,
      untagged: withUntagged,
    };

    const [files, untagged] = await this.backend.countFiles(options, criteria);
    runInAction(async () => {
      if (this.showsAllContent) {
        this.numTotalFiles = files ?? this.numTotalFiles;
        this.numFilteredFiles = files ?? this.numTotalFiles;
        this.dirtyTotalFiles = false;
      } else {
        this.numFilteredFiles = files ?? 0;
      }
      if (this.showsUntaggedContent) {
        this.numUntaggedFiles = files ?? this.numUntaggedFiles;
      } else {
        this.numUntaggedFiles = untagged ?? this.numUntaggedFiles;
      }
      this.dirtyUntaggedFiles = false;
      if (withMissing) {
        const missingCount = await this._fetchMissingFiles(true);
        runInAction(() => {
          this.numMissingFiles = missingCount;
          this.dirtyMissingFiles = false;
        });
      }
    });
  }

  /** Initializes the total and untagged file counters by querying the database with count operations */
  async refetchFileCounts(): Promise<void> {
    const [numTotalFiles, numUntaggedFiles] = await this.backend.countFiles({
      files: true,
      untagged: true,
    });
    runInAction(() => {
      this.numUntaggedFiles = numUntaggedFiles ?? 0;
      this.numTotalFiles = numTotalFiles ?? 0;
    });
  }

  @action private setOrderDirection(order: OrderDirection) {
    if (this.orderBy === 'random') {
      // new random order by clicking again order by random
      this.backend.setSeed();
    }
    this.orderDirection = order;
  }

  @action private setOrderBy(prop: OrderBy<FileDTO> = 'dateAdded') {
    if (prop === 'random') {
      // new random order
      this.backend.setSeed();
    }
    this.orderBy = prop;
  }

  @action private setOrderByExtraProperty(extraPropertyID: ID = '') {
    this.orderByExtraProperty = extraPropertyID;
  }

  @action private incrementNumMissingFiles() {
    this.numMissingFiles++;
  }

  /** Wrapper function that handles common saving status logic to filteredBackendfiles */
  @action private async handleSavingToFilteredFiles<T>(
    backendLambdaFN: (criterias: ConditionGroupDTO<FileDTO>) => Promise<T>,
  ): Promise<T | null> {
    const criterias = this.rootStore.uiStore.searchRootGroup.toCondition(this.rootStore);
    this.setIsSaving(true);
    this.incrementPendingSaves();
    const result = await backendLambdaFN(criterias).catch((e) => {
      console.error(e);
      return null;
    });
    this.decrementPendingSaves();
    if (this.pendingSaves === 0) {
      this.setIsSaving(false);
    }
    return result;
  }

  /** Adds specified tags to files matching current filters. */
  @action async addTagsToFilteredFiles(tags: ClientTag[]): Promise<void> {
    const tagIds = tags.map((t) => {
      this.addRecentlyUsedTag(t);
      return t.id;
    });
    await this.handleSavingToFilteredFiles(
      async (c) => await this.backend.addTagsToFiles(tagIds, c),
    );
  }

  /** Removes specified tags to files matching current filters. */
  @action async removeTagsFromFilteredFiles(tags: ClientTag[]): Promise<void> {
    const tagIds = tags.map((t) => {
      this.addRecentlyUsedTag(t);
      return t.id;
    });
    await this.handleSavingToFilteredFiles(
      async (c) => await this.backend.removeTagsFromFiles(tagIds, c),
    );
  }

  private isDispatchingToBackend = false;

  @action async dispatchToFilteredFiles(
    dispatchClientFiles: (files: ClientFile[]) => Promise<void>,
    showProgressToaster?: (progress: number) => void,
    isCanceled?: () => boolean,
    showFinishProgressToaster?: (total: number, succesCount: number, status: Status) => void,
    batchSize = 250,
  ): Promise<void> {
    if (this.isDispatchingToBackend) {
      AppToaster.show(
        {
          message: 'Saving to all selected files already in progress...',
          timeout: 6000,
          type: 'error',
        },
        'is-dispatching-to-backend',
      );
      return;
    }
    let _isCancelled = false;
    const handleCancelled = () => {
      _isCancelled = true;
    };
    const isCanceledWrap = () => Boolean(isCanceled?.() || _isCancelled);

    const uiStore = this.rootStore.uiStore;
    this.isDispatchingToBackend = true;
    const total = this.numFilteredFiles;
    let count = 0;
    let status: Status = Status.success;

    // if not pogresstoaster provided use a default one.
    const definedShowProgressToaster =
      showProgressToaster !== undefined
        ? showProgressToaster
        : (progress: number) =>
            AppToaster.show(
              {
                message: `Saving ${total} Files ${(progress * 100).toFixed(1)}%...`,
                timeout: 0,
                clickAction: {
                  label: 'Cancel',
                  onClick: handleCancelled,
                },
              },
              'is-dispatching-to-backend',
            );

    try {
      definedShowProgressToaster(0);
      const criterias = uiStore.searchRootGroup.toCondition(this.rootStore);
      const modifiedFilesCount = await batchReducer(
        makeFileBatchFetcher(this.backend, batchSize, criterias),
        async (batch, acc) => {
          const { newFiles } = await this.filesFromBackend(batch, false, true);
          const clientFiles = newFiles.filter(
            (clientFile): clientFile is ClientFile => !!clientFile,
          );

          // remove mobx observer
          clientFiles.forEach((f) => f.dispose());
          // apply changes
          await dispatchClientFiles(clientFiles);
          // save files
          runInAction(() => {
            clientFiles.forEach((f) => this.save(f.serialize()));
          });
          await this.saveFilesToSave();

          acc = acc + clientFiles.length;
          count = acc;
          definedShowProgressToaster(acc / total);
          return acc;
        },
        0,
        isCanceledWrap,
      );
      count = modifiedFilesCount;
    } catch (error) {
      status = Status.error;
      console.error('ERROR WHILE DISPATCHING TO BACKEND FILES', error);
    }
    if (isCanceledWrap() && status !== Status.error) {
      status = Status.aborted;
    }
    if (showFinishProgressToaster) {
      showFinishProgressToaster(total, count, status);
    } else {
      const strings = {
        [Status.success]: ['Succesfuly saved', '', 'success'],
        [Status.error]: ['Saved', ' with errors', 'error'],
        [Status.aborted]: ['Saved', ' and cancelled', 'warning'],
      }[status];
      AppToaster.show(
        {
          message: `${strings[0]} ${count} files${strings[1]}.`,
          timeout: 0,
          type: strings[2] as IToastProps['type'],
        },
        'is-dispatching-to-backend',
      );
    }
    this.isDispatchingToBackend = false;
  }
}

export enum Status {
  success = 'success',
  error = 'error',
  aborted = 'aborted',
}

export default FileStore;
