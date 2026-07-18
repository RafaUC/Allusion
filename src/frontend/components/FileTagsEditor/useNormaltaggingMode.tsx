import { normalizeBase } from 'common/core';
import { action, computed, IComputedValue } from 'mobx';
import React, { useCallback, useEffect, useMemo } from 'react';
import { useStore } from 'src/frontend/contexts/StoreContext';
import { ClientTag } from 'src/frontend/entities/Tag';
import {
  createGetTabMatchTagCallback,
  createTagRowRenderer,
  GetTabMatchTag,
  isTagSelected,
} from '../TagSelector';
import { observer } from 'mobx-react-lite';
import { CREATE_OPTION, CreateOption } from './specialOptions';
import { VirtualizedGridRowProps } from 'widgets/combobox/Grid';

export interface useNormaltaggingModeProps {
  // if the computations of the hook should be executed,
  active: boolean;
  popupId: string;
  inputText: string;
  counter: IComputedValue<Map<ClientTag, [number, boolean]>>;
  getTabMatchTagRef: React.MutableRefObject<GetTabMatchTag>;
  resetTextBox: (force?: boolean) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLElement>, tag: ClientTag) => void;
}

/**
 * manages the internal state for normal Tagging mode
 * and retunrs the necessary state and callbacks to control the fileTagsEditor
 */
const useNormaltaggingMode = ({
  active,
  popupId,
  inputText,
  counter,
  getTabMatchTagRef,
  resetTextBox,
  onContextMenu,
}: useNormaltaggingModeProps) => {
  const { tagStore, uiStore, tagPaletteStore } = useStore();

  const { matches, widestItem } = useMemo(
    () =>
      computed(
        (): { matches: (string | symbol | ClientTag)[]; widestItem: ClientTag | undefined } => {
          const activePallete = tagPaletteStore.activePallete; // also works to avoid mobx alerts
          const usePalette = activePallete !== undefined;
          if (!active) {
            return { matches: [], widestItem: undefined };
          }
          if (!usePalette && inputText.length === 0) {
            let widest: ClientTag | undefined = undefined;
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
            const includeSubtags = !usePalette && uiStore.isIncludeSubtagsOnMatchEnabled;
            let widest: ClientTag | undefined = undefined;
            const normalizedInput = normalizeBase(inputText);
            const exactMatches: ClientTag[] = [];
            const otherMatches: ClientTag[] = [];
            const visited = new Set<ClientTag>();
            const activeTagList = activePallete?.tags ?? tagStore.tagList;
            for (const tag of activeTagList) {
              if (includeSubtags && visited.has(tag)) {
                continue;
              }
              const match = tag.isMatch(normalizedInput);
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
            // Bring exact matches to the top of the suggestions. This helps find tags with short names
            // that would otherwise get buried under partial matches if they appeared lower in the list.
            // if no tag pallete is used, append CREATE_OPTION to render the create option component.
            const createOptionMatches =
              exactMatches.length > 0 || otherMatches.length > 0
                ? ['', CREATE_OPTION]
                : [CREATE_OPTION];
            return {
              matches: [
                ...exactMatches,
                ...otherMatches,
                ...(!usePalette ? createOptionMatches : []),
              ],
              widestItem: widest,
            };
          }
        },
      ),
    [
      active,
      counter,
      inputText,
      tagPaletteStore.activePallete,
      tagStore.tagList,
      uiStore.isIncludeSubtagsOnMatchEnabled,
      uiStore.recentlyUsedTags,
    ],
  ).get();

  useEffect(() => {
    getTabMatchTagRef.current = createGetTabMatchTagCallback(matches);
    for (const posibleTag of matches) {
      if (posibleTag instanceof ClientTag) {
        posibleTag.shiftAliasToFront();
      }
    }
  }, [getTabMatchTagRef, matches]);

  // When selecting all filles there's no way to know the true selected statos so instead
  // we use a map to track the checked status.
  // reset it using usingmemo each time isAllFilesSelected changes
  const allSelectedToggleStatus = useMemo(() => {
    if (uiStore.isAllFilesSelected) {
      return new Map<string, boolean>();
    } else {
      return undefined;
    }
  }, [uiStore.isAllFilesSelected]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const toggleSelection = useCallback(
    action(async (isSelected: boolean, tag: ClientTag) => {
      resetTextBox();
      if (isSelected) {
        allSelectedToggleStatus?.set(tag.id, false);
        await uiStore.removeTagsFromSelectedFiles([tag]);
      } else {
        allSelectedToggleStatus?.set(tag.id, true);
        await uiStore.addTagsToSelectedFiles([tag]);
      }
    }),
    [resetTextBox, allSelectedToggleStatus],
  );

  const isSelected: isTagSelected = useCallback(
    // define the selected satus:
    // - if any file has it, mark it as explicit
    // - if not all selected files have the tag or is selecting all filtered
    //   files and its allSelectedToggleStatus is false, mark it as partial
    (tag: ClientTag) => {
      const tagRecord = counter.get().get(tag);
      const isExplicit = tagRecord?.[1] ?? false;
      const isPartial =
        tagRecord?.[0] !== uiStore.fileSelection.size ||
        (allSelectedToggleStatus && !allSelectedToggleStatus.get(tag.id));
      return [tagRecord !== undefined && !isPartial, isExplicit];
    },
    [allSelectedToggleStatus, counter, uiStore],
  );

  const VirtualizableTagOption = useMemo(
    () =>
      observer(
        createTagRowRenderer({
          id: popupId,
          isSelected: isSelected,
          toggleSelection: toggleSelection,
          onContextMenu: onContextMenu,
        }),
      ),
    [isSelected, onContextMenu, popupId, toggleSelection],
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

  return {
    matches,
    widestItem,
    toggleSelection,
    VirtualizableTagOption,
    VirtualizableCreateOption,
  };
};

export default useNormaltaggingMode;
