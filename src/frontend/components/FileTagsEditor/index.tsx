import { IComputedValue } from 'mobx';
import { observer } from 'mobx-react-lite';
import React, {
  ForwardedRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { debounce } from 'common/timeout';
import { Tag } from 'widgets';
import {
  RowSeparator,
  useVirtualizedGridFocus,
  VirtualizedGrid,
  VirtualizedGridHandle,
  VirtualizedGridRowProps,
} from 'widgets/combobox/Grid';
import { GetTabMatchTag, useTabTagAutocomplete } from '../TagSelector';
import { useStore } from '../../contexts/StoreContext';
import { ClientTag } from '../../entities/Tag';
import { useAction, useAutorun, useComputed } from '../../hooks/mobx';
import { Menu, useContextMenu } from 'widgets/menus';
import { EditorTagSummaryItems } from '../../containers/ContentView/menu-items';
import { useGalleryInputKeydownHandler } from 'src/frontend/hooks/useHandleInputKeydown';
import useFocusEnforcer from '../../hooks/useFocusEnforcer';
import { BULK_APPLY_OPTION, CREATE_OPTION } from './specialOptions';
import useNormaltaggingMode from './useNormaltaggingMode';
import useBulkTaggingMode, { BulkTag, isBulkText } from './useBulkTaggingMode';
import { useScopeInteraction } from 'src/frontend/hooks/useScopeInteraction';
import FocusManager from 'src/frontend/FocusManager';

const POPUP_ID = 'tag-editor-popup';
const PANEL_SIZE_ID = 'tag-editor-height';
const PANEL_SUMMARY_SIZE_ID = 'tag-editor-summary-height';
const REM_VALUE = parseFloat(getComputedStyle(document.documentElement).fontSize);
const MIN_SUMMARY_THRESHOLD = REM_VALUE * 2.1;

export const FileTagsEditor = observer(() => {
  const { uiStore } = useStore();
  const clearInputOnSelect = uiStore.isClearTagSelectorsOnSelectEnabled;
  const [inputText, setInputText] = useState('');
  const [dobuncedQuery, setDebQuery] = useState('');

  const debounceSetDebQuery = useRef(debounce(setDebQuery)).current;
  useEffect(() => {
    if (inputText.length == 0 || inputText.length > 2) {
      setDebQuery(inputText);
    }
    // allways call the debounced version to avoud old calls with outdated query values to be set
    debounceSetDebQuery(inputText);
  }, [debounceSetDebQuery, inputText]);

  const counter = useComputed(() => {
    const fileSelection = Array.from(uiStore.fileSelection);
    const isTooMany = uiStore.isAllFilesSelected || fileSelection.length > 1000;
    // Count how often tags are used // Aded last bool value indicating if is an explicit tag -> should show delete button;
    const counter = new Map<ClientTag, [number, boolean]>();
    for (const file of fileSelection) {
      const explicitTags = file.tags;
      // Compute inherited tags only when the selection is not too large to avoid UI blocking
      const inheritedTags = isTooMany ? [] : file.inheritedTags;
      for (const tag of isTooMany ? explicitTags : inheritedTags) {
        const counterEntry = counter.get(tag);
        if (counterEntry) {
          counterEntry[0]++;
          counterEntry[1] ||= explicitTags.has(tag);
        } else {
          counter.set(tag, [1, explicitTags.has(tag)]);
        }
      }
    }
    const sortedEntries = Array.from(counter.entries()).sort(
      ([tagA], [tagB]) => tagA.flatIndex - tagB.flatIndex,
    );
    const sortedCounter = new Map(sortedEntries);
    return sortedCounter;
  });
  //read counter once to avoid losing it's cache if it is not used in any child
  counter.get();

  const inputRef = useRef<HTMLInputElement>(null);
  // Autofocus
  useAutorun(() => {
    if (uiStore.focusTagEditor) {
      requestAnimationFrame(() => requestAnimationFrame(() => inputRef.current?.focus()));
      uiStore.setFocusTagEditor(false);
    }
  });

  const handleInput = useRef((e: React.ChangeEvent<HTMLInputElement>) =>
    setInputText(e.target.value),
  ).current;

  // this callback transforms line breaks when pasting for bulk
  const handlePaste = useRef((e: React.ClipboardEvent<HTMLInputElement>) => {
    const pastedText = e.clipboardData.getData('text');
    if (/[\n\r,]/.test(pastedText)) {
      e.preventDefault(); // prevent singleline handleInput
      const flattenedText = pastedText.replace(/[\n\r]+/g, ', ').trim();
      setInputText(flattenedText);
    }
  }).current;

  const getTabMatchTagRef = useRef<GetTabMatchTag>(() => undefined);
  const gridRef = useRef<VirtualizedGridHandle>(null);
  const [activeDescendant, handleGridFocus] = useVirtualizedGridFocus(gridRef);
  const handleGalleryInput = useGalleryInputKeydownHandler();
  const handleTabTagAutocomplete = useTabTagAutocomplete(getTabMatchTagRef, gridRef, setInputText);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Tab') {
        handleTabTagAutocomplete(e);
      } else {
        handleGalleryInput(e);
        handleGridFocus(e);
      }
    },
    [handleGalleryInput, handleGridFocus, handleTabTagAutocomplete],
  );

  useEffect(() => gridRef.current?.scrollToItem(-1), [dobuncedQuery]);

  // Remember the height when panels are resized
  const panelRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [storedHeight] = useState(localStorage.getItem(PANEL_SIZE_ID));
  const [storedSummaryHeight] = useState(localStorage.getItem(PANEL_SUMMARY_SIZE_ID));
  const [showSummary, setShowSummary] = useState(
    storedSummaryHeight ? parseFloat(storedSummaryHeight) > MIN_SUMMARY_THRESHOLD : true,
  );
  useEffect(() => {
    if (!panelRef.current || !summaryRef.current) {
      return;
    }
    const storeHeight = debounce((val: string) => localStorage.setItem(PANEL_SIZE_ID, val));
    const storeSummaryHeight = debounce((val: string) =>
      localStorage.setItem(PANEL_SUMMARY_SIZE_ID, val),
    );
    const updateMaxSummaryHeight = () => {
      if (panelRef.current && inputRef.current && summaryRef.current) {
        const containerHeight = panelRef.current.clientHeight;
        const computedStyle = getComputedStyle(inputRef.current);
        const offsetHeight = inputRef.current.offsetHeight;
        const marginTop = parseFloat(computedStyle.marginTop);
        const marginBottom = parseFloat(computedStyle.marginBottom);
        const totalInputHeight = offsetHeight + marginTop + marginBottom;
        const maxSummaryHeight = containerHeight - totalInputHeight;
        summaryRef.current.style.maxHeight = `${maxSummaryHeight}px`;
      }
    };
    let rafID = 0;
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (
          mutation.type == 'attributes' &&
          mutation.attributeName === 'style' &&
          panelRef.current &&
          inputRef.current
        ) {
          storeHeight(panelRef.current.style.height);
          if (rafID) {
            cancelAnimationFrame(rafID);
          }
          rafID = requestAnimationFrame(() => {
            updateMaxSummaryHeight();
          });
        }
      });
    });
    observer.observe(panelRef.current, { attributes: true });
    const summaryObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (
          mutation.type == 'attributes' &&
          mutation.attributeName === 'style' &&
          summaryRef.current
        ) {
          const height = summaryRef.current.style.height;
          storeSummaryHeight(height);
          if (rafID) {
            cancelAnimationFrame(rafID);
          }
          rafID = requestAnimationFrame(() => {
            setShowSummary(parseFloat(height) > MIN_SUMMARY_THRESHOLD);
          });
        }
      });
    });
    summaryObserver.observe(summaryRef.current, { attributes: true });
    updateMaxSummaryHeight();

    return () => {
      observer.disconnect();
      summaryObserver.disconnect();
      if (rafID) {
        cancelAnimationFrame(rafID);
      }
    };
  }, []);

  const resetTextBox = useCallback(
    (force?: boolean) => {
      inputRef.current?.focus();
      if (clearInputOnSelect || force) {
        setInputText('');
      } else {
        inputRef.current?.select();
      }
      inputRef.current?.focus();
    },
    [clearInputOnSelect],
  );

  const removeTag = useAction(async (tag: ClientTag) => {
    await uiStore.removeTagsFromSelectedFiles([tag]);
    inputRef.current?.focus();
  });

  useFocusEnforcer({
    ref: panelRef,
    isActive: !uiStore.areFileEditorsDocked,
    onFocusLost: resetTextBox,
  });

  const handleTagContextMenu = TagSummaryMenu();

  return (
    <div
      ref={panelRef}
      id="tag-editor"
      style={{ height: storedHeight ?? undefined }}
      role="combobox"
      data-docked={uiStore.areFileEditorsDocked}
      aria-haspopup="grid"
      aria-expanded="true"
      aria-owns={POPUP_ID}
    >
      <input
        type="text"
        spellCheck={false}
        value={inputText}
        aria-autocomplete="list"
        onChange={handleInput}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        className="input"
        aria-controls={POPUP_ID}
        aria-activedescendant={activeDescendant}
        ref={inputRef}
      />
      <MatchingTagsList
        ref={gridRef}
        inputText={dobuncedQuery}
        getTabMatchTagRef={getTabMatchTagRef}
        counter={counter}
        resetTextBox={resetTextBox}
        onContextMenu={handleTagContextMenu}
      />
      <div ref={summaryRef} style={{ height: storedSummaryHeight ?? undefined }}>
        {uiStore.fileSelection.size === 0 ? (
          <div><i><b>No files selected</b></i></div> // eslint-disable-line prettier/prettier
        ) : (
          showSummary && (
            <TagSummary
              counter={counter}
              removeTag={removeTag}
              onContextMenu={handleTagContextMenu}
            />
          )
        )}
      </div>
    </div>
  );
});

interface MatchingTagsListProps {
  inputText: string;
  getTabMatchTagRef: React.MutableRefObject<GetTabMatchTag>;
  counter: IComputedValue<Map<ClientTag, [number, boolean]>>;
  resetTextBox: (force?: boolean) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLElement>, tag: ClientTag) => void;
}

const MatchingTagsList = observer(
  React.forwardRef(function MatchingTagsList(
    { inputText, counter, resetTextBox, onContextMenu, getTabMatchTagRef }: MatchingTagsListProps,
    ref: ForwardedRef<VirtualizedGridHandle>,
  ) {
    const isBulkMode = useMemo(() => isBulkText(inputText), [inputText]);

    const bulkC = useBulkTaggingMode({
      active: isBulkMode,
      inputText,
      popupId: POPUP_ID,
      resetTextBox,
    });
    const normalC = useNormaltaggingMode({
      active: !isBulkMode,
      inputText,
      popupId: POPUP_ID,
      counter,
      getTabMatchTagRef,
      resetTextBox,
      onContextMenu,
    });

    const VirtualizableCreateOption = normalC.VirtualizableCreateOption;
    const VirtualBulkApplyOption = bulkC.VirtualizableBulkApplyOption;
    const VirtualizableTagOption = normalC.VirtualizableTagOption;
    const VirtualizableBulkTagOption = bulkC.VirtualizableTagOption;
    const matches = isBulkMode ? bulkC.matches : normalC.matches;
    const widestItem = isBulkMode ? bulkC.widestItem : normalC.widestItem;

    const row = useMemo(() => {
      const row = (rowProps: VirtualizedGridRowProps<ClientTag | BulkTag | symbol | string>) => {
        const item = rowProps.data[rowProps.index];
        if (item === CREATE_OPTION) {
          return <VirtualizableCreateOption {...(rowProps as VirtualizedGridRowProps<symbol>)} />;
        } else if (item === BULK_APPLY_OPTION) {
          return <VirtualBulkApplyOption {...(rowProps as VirtualizedGridRowProps<symbol>)} />;
        } else if (typeof item === 'string') {
          const { position, top, height } = rowProps.style ?? {};
          return <RowSeparator label={item} style={{ position, top, height }} />;
        } else if (item instanceof ClientTag) {
          return <VirtualizableTagOption {...(rowProps as VirtualizedGridRowProps<ClientTag>)} />;
        } else {
          return <VirtualizableBulkTagOption {...(rowProps as VirtualizedGridRowProps<BulkTag>)} />;
        }
      };
      return row;
    }, [
      VirtualBulkApplyOption,
      VirtualizableBulkTagOption,
      VirtualizableCreateOption,
      VirtualizableTagOption,
    ]);

    return (
      <VirtualizedGrid
        ref={ref}
        id={POPUP_ID}
        itemData={matches}
        sampleItem={widestItem}
        height={'100%'}
        children={row}
        multiselectable
      />
    );
  }),
);

interface TagSummaryProps {
  counter: IComputedValue<Map<ClientTag, [number, boolean]>>;
  removeTag: (tag: ClientTag) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLElement>, tag: ClientTag) => void;
}

const TagSummary = observer(({ counter, removeTag, onContextMenu }: TagSummaryProps) => {
  const { uiStore } = useStore();
  const sortedTags: ClientTag[] = Array.from(counter.get().entries())
    // Sort based on count
    .sort((a, b) => b[1][0] - a[1][0])
    .map((pair) => pair[0]);

  return (
    <div className="config-scrollbar" onMouseDown={(e) => e.preventDefault()}>
      <IncrementalTagItems
        tags={sortedTags}
        counter={counter}
        removeTag={removeTag}
        onContextMenu={onContextMenu}
        chunkSize={uiStore.fileSelection.size > 1 ? 5 : 100}
      />
      {sortedTags.length === 0 && <i><b>No tags added yet</b></i> // eslint-disable-line prettier/prettier
      }
    </div>
  );
});

interface IncrementalTagItemsProps {
  tags: ClientTag[];
  counter?: IComputedValue<Map<ClientTag, [number, boolean]>>;
  removeTag?: (tag: ClientTag) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLElement>, tag: ClientTag) => void;
  chunkSize?: number;
}

export const IncrementalTagItems = observer((props: IncrementalTagItemsProps) => {
  const { uiStore, fileStore } = useStore();
  const isMultiSelection = uiStore.fileSelection.size > 1;
  const isAllFilesSelected = uiStore.isAllFilesSelected;
  const { tags, counter, removeTag, onContextMenu, chunkSize = 5 } = props;

  const [visibleTags, setVisibleTags] = useState<ClientTag[]>([]);

  useLayoutEffect(() => {
    let index = 0;
    let cancel = false;
    setVisibleTags([]);

    const step = () => {
      if (cancel) {
        return;
      }
      const start = index;
      const end = Math.min(start + chunkSize, tags.length);
      if (end > start) {
        setVisibleTags((prev) => [...prev, ...tags.slice(start, end)]);
        index = end;
      }
      if (index < tags.length) {
        requestAnimationFrame(step);
      }
    };

    step();

    return () => {
      cancel = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tags]);

  const isAllfilesText =
    isAllFilesSelected && uiStore.fileSelection.size !== fileStore.numFilteredFiles;
  const isMultiText = counter && isMultiSelection;

  const RenderTag = useMemo(
    () =>
      observer(({ tag }: { tag: ClientTag }) => (
        <Tag
          text={`${tag.name}${
            isAllfilesText ? ' (?)' : isMultiText ? ` (${counter.get().get(tag)?.[0]})` : ''
          }`}
          color={tag.viewColor}
          isHeader={tag.isHeader}
          tooltip={tag.path
            .map((v) => (v.startsWith('#') ? '&nbsp;<b>' + v.slice(1) + '</b>&nbsp;' : v))
            .join(' › ')}
          onRemove={
            counter && removeTag && counter.get().get(tag)?.[1] ? () => removeTag(tag) : undefined
          }
          onContextMenu={onContextMenu ? (e) => onContextMenu(e, tag) : undefined}
        />
      )),
    [counter, isAllfilesText, isMultiText, onContextMenu, removeTag],
  );

  return (
    <>
      {visibleTags.map((t) => (
        <RenderTag key={t.id} tag={t} />
      ))}
    </>
  );
});

const TagSummaryMenu = () => {
  const divRef = useRef<HTMLDivElement>(null);
  const beforeSelect = useCallback(() => {
    FocusManager.focusGallery();
  }, []);
  const handleClose = useCallback(() => {
    divRef.current?.focus();
    divRef.current?.blur();
  }, []);

  useScopeInteraction({
    currentPath: 'floating-panel/file-tags-editor/tag-menu',
    onOutside: handleClose,
    elementRef: divRef,
  });

  const show = useContextMenu();
  const handleTagContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>, tag: ClientTag) => {
      event.stopPropagation();
      show(
        event.clientX,
        event.clientY,
        <div ref={divRef} tabIndex={-1}>
          <Menu>
            <EditorTagSummaryItems tag={tag} beforeSelect={beforeSelect} />
          </Menu>
        </div>,
      );
    },
    [show, beforeSelect],
  );

  return handleTagContextMenu;
};
