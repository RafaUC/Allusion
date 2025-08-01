import { computed, IComputedValue, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import React, { ForwardedRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { debounce } from 'common/timeout';
import { Tag } from 'widgets';
import {
  Row,
  RowSeparator,
  useVirtualizedGridFocus,
  VirtualizedGrid,
  VirtualizedGridHandle,
  VirtualizedGridRowProps,
} from 'widgets/combobox/Grid';
import { IconSet } from 'widgets/icons';
import { createTagRowRenderer } from './TagSelector';
import { useStore } from '../contexts/StoreContext';
import { ClientFile } from '../entities/File';
import { ClientTag } from '../entities/Tag';
import { useAction, useAutorun, useComputed } from '../hooks/mobx';
import { Menu, useContextMenu } from 'widgets/menus';
import { EditorTagSummaryItems } from '../containers/ContentView/menu-items';
import { useGalleryInputKeydownHandler } from 'src/frontend/hooks/useHandleInputKeydown';

const POPUP_ID = 'tag-editor-popup';
const PANEL_SIZE_ID = 'tag-editor-height';
const PANEL_SUMMARY_SIZE_ID = 'tag-editor-summary-height';
const REM_VALUE = parseFloat(getComputedStyle(document.documentElement).fontSize);
const MIN_SUMMARY_THRESHOLD = REM_VALUE * 2.1;

export const FileTagsEditor = observer(() => {
  const { uiStore } = useStore();
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
    const fileSelection = uiStore.fileSelection;
    // Count how often tags are used // Aded last bool value indicating if is an explicit tag -> should show delete button;
    const counter = new Map<ClientTag, [number, boolean]>();
    for (const file of fileSelection) {
      const explicitTags = file.tags;
      const inheritedTags = file.inheritedTags;
      for (let j = 0; j < inheritedTags.length; j++) {
        const tag = inheritedTags[j];
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

  const gridRef = useRef<VirtualizedGridHandle>(null);
  const [activeDescendant, handleGridFocus] = useVirtualizedGridFocus(gridRef);

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

  const resetTextBox = useRef(() => {
    setInputText('');
    inputRef.current?.focus();
  }).current;

  const removeTag = useAction((tag: ClientTag) => {
    for (const f of uiStore.fileSelection) {
      f.removeTag(tag);
    }
    inputRef.current?.focus();
  });

  const baseHandleKeydown = useGalleryInputKeydownHandler();
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      baseHandleKeydown(e);
      handleGridFocus(e);
    },
    [baseHandleKeydown, handleGridFocus],
  );

  const handleTagContextMenu = TagSummaryMenu({ parentPopoverId: 'tag-editor' });

  return (
    <div
      ref={panelRef}
      id="tag-editor"
      style={{ height: storedHeight ?? undefined }}
      role="combobox"
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
        onKeyDown={handleKeyDown}
        className="input"
        aria-controls={POPUP_ID}
        aria-activedescendant={activeDescendant}
        ref={inputRef}
      />
      <MatchingTagsList
        ref={gridRef}
        inputText={dobuncedQuery}
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

export const CREATE_OPTION = Symbol('tag_create_option');

interface MatchingTagsListProps {
  inputText: string;
  counter: IComputedValue<Map<ClientTag, [number, boolean]>>;
  resetTextBox: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLElement>, tag: ClientTag) => void;
}

const MatchingTagsList = observer(
  React.forwardRef(function MatchingTagsList(
    { inputText, counter, resetTextBox, onContextMenu }: MatchingTagsListProps,
    ref: ForwardedRef<VirtualizedGridHandle>,
  ) {
    const { tagStore, uiStore } = useStore();

    const { matches, widestItem } = useMemo(
      () =>
        computed(() => {
          if (inputText.length === 0) {
            let widest = undefined;
            // string matches creates separators
            const matches: (symbol | ClientTag | string)[] = [];
            // Add recently used tags.
            if (uiStore.recentlyUsedTags.length > 0) {
              matches.push('Recently used tags');
              for (const tag of uiStore.recentlyUsedTags) {
                matches.push(tag);
                widest = widest ? (tag.pathCharLength > widest.pathCharLength ? tag : widest) : tag;
              }
              if (counter.get().size > 0) {
                matches.push('Assigned tags');
              }
            }
            for (const tag of counter.get().keys()) {
              matches.push(tag);
              widest = widest ? (tag.pathCharLength > widest.pathCharLength ? tag : widest) : tag;
            }
            // Always append CREATE_OPTION to render the create option component.
            matches.push(CREATE_OPTION);
            return { matches: matches, widestItem: widest };
          } else {
            let widest = undefined;
            const textLower = inputText.toLowerCase();
            const exactMatches: ClientTag[] = [];
            const otherMatches: ClientTag[] = [];
            for (const tag of tagStore.tagList) {
              let validFlag = false;
              const nameLower = tag.name.toLowerCase();
              if (nameLower === textLower) {
                exactMatches.push(tag);
                validFlag = true;
              } else if (nameLower.includes(textLower)) {
                otherMatches.push(tag);
                validFlag = true;
              }
              if (validFlag) {
                widest = widest ? (tag.pathCharLength > widest.pathCharLength ? tag : widest) : tag;
              }
            }
            // Bring exact matches to the top of the suggestions. This helps find tags with short names
            // that would otherwise get buried under partial matches if they appeared lower in the list.
            // Always append CREATE_OPTION to render the create option component.
            const createOptionMatches =
              exactMatches.length > 0 || otherMatches.length > 0
                ? ['', CREATE_OPTION]
                : [CREATE_OPTION];
            return {
              matches: [...exactMatches, ...otherMatches, ...createOptionMatches],
              widestItem: widest,
            };
          }
        }),
      [counter, inputText, tagStore.tagList, uiStore.recentlyUsedTags],
    ).get();

    const toggleSelection = useRef(
      useAction((isSelected: boolean, tag: ClientTag) => {
        const operation = isSelected
          ? (f: ClientFile) => f.removeTag(tag)
          : (f: ClientFile) => f.addTag(tag);
        uiStore.fileSelection.forEach(operation);
        resetTextBox();
      }),
    ).current;

    const isSelected = useCallback(
      // If all selected files have the tag mark it as selected,
      // else if partially in selected files return undefined, else mark it as not selected.
      (tag: ClientTag) => {
        const tagRecord = counter.get().get(tag);
        const isExplicit = tagRecord?.[1] ?? false;
        const isPartial = tagRecord?.[0] !== uiStore.fileSelection.size;
        return isExplicit ? (isPartial ? undefined : true) : false;
      },
      [counter, uiStore],
    );
    const VirtualizableTagOption = useMemo(
      () =>
        observer(
          createTagRowRenderer({
            id: POPUP_ID,
            isSelected: isSelected,
            toggleSelection: toggleSelection,
            onContextMenu: onContextMenu,
          }),
        ),
      [isSelected, onContextMenu, toggleSelection],
    );
    const VirtualizableCreateOption = useMemo(() => {
      const VirtualizableCreateOption = ({ index, style }: VirtualizedGridRowProps<symbol>) => {
        return (
          <CreateOption
            key={index}
            index={index}
            style={style}
            inputText={inputText}
            //matches always have at least the CREATE_OPTION item, so check if it's bigger than 1.
            hasMatches={matches.length > 1}
            resetTextBox={resetTextBox}
          />
        );
      };
      return VirtualizableCreateOption;
    }, [inputText, matches.length, resetTextBox]);

    const row = useMemo(() => {
      const row = (rowProps: VirtualizedGridRowProps<ClientTag | symbol | string>) => {
        const item = rowProps.data[rowProps.index];
        if (item === CREATE_OPTION) {
          return <VirtualizableCreateOption {...(rowProps as VirtualizedGridRowProps<symbol>)} />;
        } else if (typeof item === 'string') {
          const { position, top, height } = rowProps.style ?? {};
          return <RowSeparator label={item} style={{ position, top, height }} />;
        } else {
          return <VirtualizableTagOption {...(rowProps as VirtualizedGridRowProps<ClientTag>)} />;
        }
      };
      return row;
    }, [VirtualizableCreateOption, VirtualizableTagOption]);

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

interface CreateOptionProps {
  inputText: string;
  hasMatches: boolean;
  resetTextBox: () => void;
  style?: React.CSSProperties | undefined;
  index?: number;
}

const CreateOption = ({ inputText, hasMatches, resetTextBox, style, index }: CreateOptionProps) => {
  const { tagStore, uiStore } = useStore();

  const createTag = useCallback(async () => {
    const newTag = await tagStore.create(tagStore.root, inputText);
    runInAction(() => {
      for (const f of uiStore.fileSelection) {
        f.addTag(newTag);
      }
    });
    resetTextBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputText, resetTextBox]);

  return (
    <>
      {inputText.length > 0 ? (
        <>
          <Row
            id="tag-editor-create-option"
            index={index}
            style={style}
            selected={false}
            value={`Create Tag "${inputText}"`}
            onClick={createTag}
            icon={IconSet.TAG_ADD}
          />
        </>
      ) : (
        !hasMatches && (
          <Row style={style} key="empty-message" value="Type to select tags&nbsp;&nbsp;" />
        )
      )}
    </>
  );
};

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
      {sortedTags.map((t) => (
        <Tag
          key={t.id}
          text={`${t.name}${
            uiStore.fileSelection.size > 1 ? ` (${counter.get().get(t)?.[0]})` : ''
          }`}
          color={t.viewColor}
          //Only show remove button in those tags that are actually assigned to the file(s) and not only inherited
          onRemove={counter.get().get(t)?.[1] ? () => removeTag(t) : undefined}
          onContextMenu={onContextMenu !== undefined ? (e) => onContextMenu(e, t) : undefined}
        />
      ))}
      {sortedTags.length === 0 && <i><b>No tags added yet</b></i> // eslint-disable-line prettier/prettier
      }
    </div>
  );
});

interface ITagSummaryMenu {
  parentPopoverId: string;
}

const TagSummaryMenu = ({ parentPopoverId }: ITagSummaryMenu) => {
  const getFocusableElement = useCallback(() => {
    return document
      .getElementById(parentPopoverId)
      ?.querySelector('input, textarea, button, a, select, [tabindex]') as HTMLElement | null;
  }, [parentPopoverId]);
  const handleMenuBlur = useCallback(
    (e: React.FocusEvent) => {
      if (!e.relatedTarget?.closest('[data-popover="true"]')) {
        const element = getFocusableElement();
        if (element && element instanceof HTMLElement) {
          element.focus();
          element.blur();
        }
      }
    },
    [getFocusableElement],
  );
  const handleMenuKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        const element = getFocusableElement();
        e.stopPropagation();
        if (element && element instanceof HTMLElement) {
          element.focus();
          element.blur();
        }
      }
    },
    [getFocusableElement],
  );
  const beforeSelect = useCallback(() => {
    const element = getFocusableElement();
    if (element && element instanceof HTMLElement) {
      element.focus();
      element.blur();
    }
  }, [getFocusableElement]);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const divRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeMenuId && divRef.current) {
      divRef.current.focus();
    }
  }, [activeMenuId]);

  const show = useContextMenu();
  const handleTagContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>, tag: ClientTag) => {
      event.stopPropagation();
      show(
        event.clientX,
        event.clientY,
        <div ref={divRef} onBlur={handleMenuBlur} onKeyDown={handleMenuKeyDown} tabIndex={-1}>
          <Menu>
            <EditorTagSummaryItems tag={tag} beforeSelect={beforeSelect} />
          </Menu>
        </div>,
      );
      setActiveMenuId(tag.id);
    },
    [show, handleMenuBlur, handleMenuKeyDown, beforeSelect],
  );

  return handleTagContextMenu;
};
