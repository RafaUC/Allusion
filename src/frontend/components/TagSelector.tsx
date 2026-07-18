import { observer } from 'mobx-react-lite';
import React, {
  ForwardedRef,
  forwardRef,
  ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { GridCell, IconButton, IconSet, Row, Tag } from 'widgets';
import {
  RowProps,
  RowSeparator,
  useVirtualizedGridFocus,
  VirtualizedGrid,
  VirtualizedGridHandle,
  VirtualizedGridRowProps,
} from 'widgets/combobox/Grid';
import { Flyout } from 'widgets/popovers';
import { useStore } from '../contexts/StoreContext';
import { ClientTag } from '../entities/Tag';
import { useComputed } from '../hooks/mobx';
import { debounce } from 'common/timeout';
import { useGalleryInputKeydownHandler } from '../hooks/useHandleInputKeydown';
import { Placement, Strategy } from '@floating-ui/core';
import { computed, runInAction } from 'mobx';
import { normalizeBase } from 'common/core';

export interface TagSelectorProps {
  selection: ClientTag[] | [ClientTag, boolean][];
  onSelect: (item: ClientTag) => void;
  onDeselect: (item: ClientTag) => void;
  onTagClick?: (item: ClientTag) => void;
  onClear: () => void;
  disabled?: boolean;
  extraIconButtons?: ReactElement;
  renderCreateOption?: (
    inputText: string,
    resetTextBox: () => void,
  ) => ReactElement<RowProps> | ReactElement<RowProps>[];
  multiline?: boolean;
  filter?: (tag: ClientTag) => boolean;
  showTagContextMenu?: (e: React.MouseEvent<HTMLElement>, tag: ClientTag) => void;
  ignoreOnBlur?: (e: React.FocusEvent) => boolean;
  placement?: Placement;
  fallbackPlacements?: Placement[];
  strat?: Strategy;
  clearInputOnSelect?: boolean;
  disableTagPalletes?: boolean;
}

const DEFAULT_FALLBACK_PLACEMENTS: Placement[] = ['left-end', 'top-start', 'right-end'];

const _TagSelector = forwardRef<HTMLInputElement, TagSelectorProps>(function TargetTagSelector(
  props,
  ref,
) {
  const { uiStore } = useStore();
  const {
    selection,
    onSelect,
    onDeselect,
    onTagClick,
    showTagContextMenu,
    ignoreOnBlur,
    onClear,
    disabled,
    extraIconButtons,
    renderCreateOption,
    multiline,
    filter,
    placement = 'bottom-start',
    fallbackPlacements = DEFAULT_FALLBACK_PLACEMENTS,
    strat,
    clearInputOnSelect = uiStore.isClearTagSelectorsOnSelectEnabled,
    disableTagPalletes = true,
  } = props;
  uiStore.isClearTagSelectorsOnSelectEnabled; // avoid mobx unused observer warning
  const gridId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [forceCreateOption, setForceCreateOption] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebQuery] = useState('');

  const setInputRef = (element: HTMLInputElement | null) => {
    (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = element;
    if (!ref) {
      return;
    }
    if (typeof ref === 'function') {
      ref(element);
    } else {
      (ref as React.MutableRefObject<HTMLInputElement | null>).current = element;
    }
  };

  /**
   * A memoized map of selected tags with their inheritance status for better perfomance.
   * - Key: The tag object
   * - Value: True if the tag is explicitly assigned (not inherited)
   */
  const selectionMap = useMemo(() => {
    if (Array.isArray(selection) && selection.length > 0 && Array.isArray(selection[0])) {
      return new Map(selection as [ClientTag, boolean][]);
    } else {
      return new Map((selection as ClientTag[]).map((tag) => [tag, true]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, selection.length]);

  const debounceSetDebQuery = useRef(debounce(setDebQuery)).current;
  useEffect(() => {
    if (query.length == 0 || query.length > 2) {
      setDebQuery(query);
    }
    // allways call the debounced version to avoud old calls with outdated query values to be set
    debounceSetDebQuery(query);
  }, [debounceSetDebQuery, query]);

  const handleChange = useRef((e: React.ChangeEvent<HTMLInputElement>) => {
    setIsOpen(true);
    setQuery(e.target.value);
  }).current;

  const clearSelection = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setQuery('');
      onClear();
    },
    [onClear],
  );

  const isInputEmpty = query.length === 0;

  const getTabMatchTagRef = useRef<GetTabMatchTag>(() => undefined);
  const gridRef = useRef<VirtualizedGridHandle>(null);
  const [activeDescendant, handleGridFocus] = useVirtualizedGridFocus(gridRef);
  const handleGalleryInput = useGalleryInputKeydownHandler();
  const handleTabTagAutocomplete = useTabTagAutocomplete(getTabMatchTagRef, gridRef, setQuery);

  useEffect(() => gridRef.current?.scrollToItem(-1), [debouncedQuery, forceCreateOption]);
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Backspace') {
        e.stopPropagation();

        // Remove last assigned item from selection with backspace
        if (isInputEmpty && selectionMap.size > 0) {
          const lastExplicitTag = Array.from(selectionMap.entries())
            .filter(([, isExplicit]) => isExplicit)
            .at(-1)?.[0];
          if (lastExplicitTag) {
            onDeselect(lastExplicitTag);
          }
        }
      } else if (e.key === 'Tab') {
        handleTabTagAutocomplete(e);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setQuery('');
        setIsOpen(false);
        inputRef.current?.blur();
      } else {
        handleGalleryInput(e);
        handleGridFocus(e);
      }
    },
    [
      isInputEmpty,
      selectionMap,
      onDeselect,
      handleTabTagAutocomplete,
      handleGalleryInput,
      handleGridFocus,
    ],
  );

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Alt') {
      setForceCreateOption((prev) => !prev);
    }
  }, []);

  const handleBlur = useRef((e: React.FocusEvent<HTMLDivElement>) => {
    // If anything is blurred, and the new focus is not the input nor the flyout, close the flyout
    const isFocusingOption =
      e.relatedTarget instanceof HTMLElement &&
      e.currentTarget.contains(e.relatedTarget) &&
      (e.relatedTarget.matches('div[role="row"]') ||
        e.relatedTarget.matches('div.virtualized-grid'));
    if (
      (ignoreOnBlur ? ignoreOnBlur(e) : false) ||
      isFocusingOption ||
      e.relatedTarget === inputRef.current
    ) {
      return;
    }
    setQuery('');
    setIsOpen(false);
  }).current;

  const handleFocus = useRef(() => setIsOpen(true)).current;

  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName !== 'INPUT') {
      inputRef.current?.focus();
    }
  }, []);

  const resetTextBox = useCallback(() => {
    inputRef.current?.focus();
    if (clearInputOnSelect) {
      setQuery('');
    } else {
      inputRef.current?.select();
    }
  }, [clearInputOnSelect]);

  const toggleSelection = useCallback(
    (isSelected: boolean, tag: ClientTag) => {
      if (!isSelected) {
        onSelect(tag);
      } else {
        onDeselect(tag);
      }
      resetTextBox();
    },
    [onDeselect, onSelect, resetTextBox],
  );

  return (
    <div
      role="combobox"
      aria-expanded={isOpen}
      aria-haspopup="grid"
      aria-owns={gridId}
      className={`tag-selector input multiautocomplete ${multiline ? 'multiline' : ''}`}
      onBlur={handleBlur}
      onClick={handleBackgroundClick}
    >
      <Flyout
        isOpen={isOpen}
        cancel={() => setIsOpen(false)}
        placement={placement}
        fallbackPlacements={fallbackPlacements}
        strat={strat}
        ignoreCloseForElementOnBlur={inputRef.current || undefined}
        target={(ref) => (
          <div ref={ref} className="multiautocomplete-input">
            <div className="input-wrapper">
              {Array.from(selectionMap.entries()).map(([tag, isExplicit]) => (
                <SelectedTag
                  key={tag.id}
                  tag={tag}
                  onDeselect={isExplicit ? onDeselect : undefined}
                  onTagClick={onTagClick}
                  showContextMenu={showTagContextMenu}
                />
              ))}
              <input
                disabled={disabled}
                type="text"
                value={query}
                aria-autocomplete="list"
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onKeyUp={handleKeyUp}
                aria-controls={gridId}
                aria-activedescendant={activeDescendant}
                ref={setInputRef}
                onFocus={handleFocus}
              />
            </div>
            {extraIconButtons}
            <IconButton icon={IconSet.CLOSE} text="Clear" onClick={clearSelection} />
          </div>
        )}
      >
        <SuggestedTagsList
          ref={gridRef}
          id={gridId}
          getTabMatchTagRef={getTabMatchTagRef}
          filter={filter}
          query={debouncedQuery}
          selectionMap={selectionMap}
          toggleSelection={toggleSelection}
          resetTextBox={resetTextBox}
          renderCreateOption={renderCreateOption}
          forceCreateOption={forceCreateOption}
          disableTagPalletes={disableTagPalletes}
        />
      </Flyout>
    </div>
  );
});
const TagSelector = observer(_TagSelector);
export { TagSelector };

interface SelectedTagProps {
  tag: ClientTag;
  onDeselect?: (item: ClientTag) => void;
  onTagClick?: (item: ClientTag) => void;
  showContextMenu?: (e: React.MouseEvent<HTMLElement>, item: ClientTag) => void;
}

const SelectedTag = observer((props: SelectedTagProps) => {
  const { tag, onDeselect, onTagClick, showContextMenu } = props;
  return (
    <Tag
      text={tag.name}
      color={tag.viewColor}
      isHeader={tag.isHeader}
      onRemove={onDeselect ? () => onDeselect(tag) : undefined}
      onClick={onTagClick !== undefined ? () => onTagClick(tag) : undefined}
      onContextMenu={showContextMenu !== undefined ? (e) => showContextMenu(e, tag) : undefined}
    />
  );
});

interface SuggestedTagsListProps {
  id: string;
  query: string;
  getTabMatchTagRef: React.MutableRefObject<GetTabMatchTag>;
  selectionMap: Map<ClientTag, boolean>;
  filter?: (tag: ClientTag) => boolean;
  toggleSelection: (isSelected: boolean, tag: ClientTag) => void;
  resetTextBox: () => void;
  renderCreateOption?: (
    inputText: string,
    resetTextBox: () => void,
  ) => ReactElement<RowProps> | ReactElement<RowProps>[];
  forceCreateOption?: boolean;
  disableTagPalletes?: boolean;
}

const SuggestedTagsList = observer(
  React.forwardRef(function TagsList(
    props: SuggestedTagsListProps,
    ref: ForwardedRef<VirtualizedGridHandle>,
  ) {
    const {
      id,
      query,
      getTabMatchTagRef,
      selectionMap,
      filter = () => true,
      toggleSelection,
      resetTextBox,
      renderCreateOption,
      forceCreateOption,
      disableTagPalletes = true,
    } = props;
    const { tagStore, uiStore, tagPaletteStore } = useStore();

    const { suggestions, widestItem } = useMemo(
      () =>
        computed(() => {
          const activePallete = disableTagPalletes ? undefined : tagPaletteStore.activePallete;
          const usePalette = activePallete !== undefined;
          if (!usePalette && query.length === 0 && !forceCreateOption) {
            let widest: ClientTag | undefined = undefined;
            const matches: (ClientTag | ReactElement<RowProps> | string)[] = [];
            // Add recently used tags.
            if (uiStore.recentlyUsedTags.length > 0) {
              matches.push('Recently used tags');
              for (const tag of uiStore.recentlyUsedTags) {
                matches.push(tag);
                widest = widest ? (tag.pathCharLength > widest.pathCharLength ? tag : widest) : tag;
              }
              if (selectionMap.size > 0) {
                matches.push('Assigned tags');
              }
            }
            for (const tag of selectionMap.keys()) {
              matches.push(tag);
              widest = widest ? (tag.pathCharLength > widest.pathCharLength ? tag : widest) : tag;
            }
            if (selectionMap.size === 0 && uiStore.recentlyUsedTags.length === 0) {
              matches.push(
                <Row key="empty-message" value="Type to search tags...&nbsp;&nbsp;"></Row>,
              );
            }
            return { suggestions: matches, widestItem: widest };
          } else {
            const includeSubtags = !usePalette && uiStore.isIncludeSubtagsOnMatchEnabled;
            let widest: ClientTag | undefined = undefined;
            const normalizedQuery = normalizeBase(query);
            const exactMatches: ClientTag[] = [];
            const otherMatches: ClientTag[] = [];
            const visited = new Set<ClientTag>();
            if (!forceCreateOption || usePalette) {
              const activeTagList = activePallete?.tags ?? tagStore.tagList;
              for (const tag of activeTagList) {
                if (includeSubtags && visited.has(tag)) {
                  continue;
                }
                if (!filter(tag)) {
                  continue;
                }
                const match = tag.isMatch(normalizedQuery);
                if (match > 0) {
                  let matchTags: Iterable<ClientTag>;
                  const targetArray = match === 1 ? exactMatches : otherMatches;
                  if (includeSubtags) {
                    matchTags = tag.getImpliedSubTree(visited);
                  } else {
                    matchTags = [tag];
                  }
                  for (const t of matchTags) {
                    widest = widest ? (t.pathCharLength > widest.pathCharLength ? t : widest) : t;
                    targetArray.push(t);
                  }
                }
              }
            } else {
              // Access at least one observable to avoid mobx warnings. Derivation 'ComputedValue@' is created/updated without reading any observable value.
              tagStore.count;
            }
            // Add create option
            const createOptionItems = (function () {
              if (exactMatches.length === 0 && otherMatches.length === 0) {
                const createOption = renderCreateOption?.(query, resetTextBox);
                return Array.isArray(createOption)
                  ? createOption
                  : createOption
                  ? [createOption]
                  : [];
              }
              return [];
            })();
            // Bring exact matches to the top of the suggestions. This helps find tags with short names
            // that would otherwise get buried under partial matches if they appeared lower in the list.
            return {
              suggestions: [
                ...exactMatches,
                ...otherMatches,
                ...(!usePalette ? createOptionItems : []),
              ],
              widestItem: widest,
            };
          }
        }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [
        query,
        tagStore.tagList,
        uiStore.recentlyUsedTags,
        tagPaletteStore.activePallete,
        renderCreateOption,
        filter,
        forceCreateOption,
      ],
    ).get();

    useEffect(() => {
      // update getTabMatchTag
      getTabMatchTagRef.current = createGetTabMatchTagCallback(suggestions);
      // update aliases order
      for (const posibleTag of suggestions) {
        if (posibleTag instanceof ClientTag) {
          posibleTag.shiftAliasToFront();
        }
      }
    }, [getTabMatchTagRef, suggestions]);

    const isSelected: isTagSelected = useCallback(
      (tag: ClientTag) => {
        const value = selectionMap.get(tag);
        return [value !== undefined, value ?? false];
      },
      [selectionMap],
    );
    const TagRow = useMemo(
      () => createTagRowRenderer({ isSelected, toggleSelection, id }),
      [isSelected, toggleSelection, id],
    );

    const row = useMemo(() => {
      const row = (
        rowProps: VirtualizedGridRowProps<ClientTag | ReactElement<RowProps> | string>,
      ) => {
        const item = rowProps.data[rowProps.index];
        if (React.isValidElement(item)) {
          const { style, index } = rowProps;
          return React.cloneElement(item, { style, index });
        } else if (typeof item === 'string') {
          const { position, top, height } = rowProps.style ?? {};
          return <RowSeparator label={item} style={{ position, top, height }} />;
        } else {
          return <TagRow {...(rowProps as VirtualizedGridRowProps<ClientTag>)} />;
        }
      };
      return row;
    }, [TagRow]);

    return (
      <>
        <VirtualizedGrid
          ref={ref}
          id={id}
          itemData={suggestions}
          sampleItem={widestItem}
          multiselectable
          itemsInView={10}
          children={row}
        />
      </>
    );
  }),
);

export type isTagSelected = (tag: ClientTag) => [assigned: boolean, explicit: boolean];

interface VirtualizableTagOption {
  id?: string;
  isSelected: isTagSelected;
  toggleSelection: (isSelected: boolean, tag: ClientTag) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLElement>, tag: ClientTag) => void;
}

export function createTagRowRenderer({
  isSelected,
  toggleSelection,
  id,
  onContextMenu,
}: VirtualizableTagOption) {
  const RowRenderer = ({ index, style, data, id: sub_id }: VirtualizedGridRowProps<ClientTag>) => {
    const tag = data[index];
    const [assigned, explicit] = isSelected(tag);
    return (
      <TagOption
        id={`${id}-${tag.id}-${sub_id}`}
        index={index}
        style={style}
        key={tag.id}
        tag={tag}
        assigned={assigned}
        explicit={explicit}
        toggleSelection={toggleSelection}
        onContextMenu={onContextMenu}
      />
    );
  };
  return RowRenderer;
}

interface TagOptionProps {
  id?: string;
  index?: number;
  tag: ClientTag;
  assigned?: boolean;
  explicit?: boolean;
  style?: React.CSSProperties;
  toggleSelection: (isSelected: boolean, tag: ClientTag) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLElement>, tag: ClientTag) => void;
}

export const TagOption = observer(
  ({
    id,
    index,
    tag,
    assigned,
    explicit,
    toggleSelection,
    onContextMenu,
    style,
  }: TagOptionProps) => {
    const [path, hint] = useComputed(() => {
      const path = tag.path
        .map((v) => (v.startsWith('#') ? '&nbsp;<b>' + v.slice(1) + '</b>&nbsp;' : v))
        .join(' › ');
      const hint = path.slice(
        0,
        Math.max(0, path.length - tag.name.length - (tag.isHeader ? 19 : 3)),
      );
      return [path, hint];
    }).get();

    return (
      <Row
        id={id}
        index={index}
        value={tag.isHeader ? <b>{tag.matchName}</b> : tag.matchName}
        selected={assigned}
        highlightCheck={explicit}
        icon={<span style={{ color: tag.viewColor }}>{IconSet.TAG}</span>}
        onClick={() => toggleSelection((assigned && explicit) ?? false, tag)}
        tooltip={path}
        onContextMenu={onContextMenu !== undefined ? (e) => onContextMenu(e, tag) : undefined}
        style={style}
        className="tag-option"
        htmlTitle={tag.description}
      >
        {hint.length > 0 ? (
          <GridCell className="tag-option-hint" __html={hint}></GridCell>
        ) : (
          <GridCell />
        )}
      </Row>
    );
  },
);

export type GetTabMatchTag = (index: number, query: string) => ClientTag | undefined;

export const useTabTagAutocomplete = (
  getTabMatchTagRef: React.MutableRefObject<GetTabMatchTag>,
  gridRef: React.RefObject<VirtualizedGridHandle>,
  setQuery: (value: React.SetStateAction<string>) => void,
) => {
  return useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      // if the activeTag exists complete the query until the next space.
      setQuery((prevQuery) => {
        const activeTag = getTabMatchTagRef.current(
          gridRef.current?.focusedIndex.current ?? -1,
          prevQuery,
        );
        if (activeTag === undefined) {
          return prevQuery;
        }
        // if the last word of the query is the same as their counterpart in the tag name add the next word,
        // otherwise complete the current word.
        const prevWords = prevQuery.split(' ');
        // generate the new Query based on the active tag match name
        const words = runInAction(() => activeTag.matchName)
          .split('→')[0]
          .split(' ')
          .filter((s) => s !== '');
        const addNext = words.at(prevWords.length - 1) === prevWords.at(-1);
        const newQuery = words.slice(0, prevWords.length + (addNext ? 1 : 0)).join(' ');
        return newQuery;
      });
    },
    [getTabMatchTagRef, gridRef, setQuery],
  );
};

export const createGetTabMatchTagCallback =
  (suggestions: (ClientTag | any)[]) => (index: number, query: string) => {
    // if no selected item, find the first clientTag in suggestions that starts with the query. otherwise return the selected item tag.
    if (index < 0) {
      const normalizedQuery = normalizeBase(query);
      return runInAction(() =>
        suggestions.find((posibleTag): posibleTag is ClientTag => {
          if (posibleTag instanceof ClientTag) {
            return normalizeBase(posibleTag.matchName).startsWith(normalizedQuery);
          }
          return false;
        }),
      );
    } else {
      const posibleTag = suggestions[index];
      return posibleTag instanceof ClientTag ? posibleTag : undefined;
    }
  };
