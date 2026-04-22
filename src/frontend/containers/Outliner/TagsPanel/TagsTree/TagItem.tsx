import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import React, { useCallback, useRef } from 'react';

import { formatTagCountText } from 'common/fmt';
import { IconSet } from 'widgets';
import { useContextMenu } from 'widgets/menus';
import { useStore } from '../../../../contexts/StoreContext';
import { useTagDnD } from '../../../../contexts/TagDnDContext';
import { ClientTagSearchCriteria } from '../../../../entities/SearchCriteria';
import { ClientTag } from '../../../../entities/Tag';
import UiStore from '../../../../stores/UiStore';
import { IExpansionState } from '../../../types';
import { HOVER_TIME_TO_EXPAND } from '../../LocationsPanel/useFileDnD';
import { Action, Factory } from '../state';
import SearchButton from '../SearchButton';
import { TagItemContextMenu } from '../ContextMenu';
import { DnDHelper } from './DragDrop';

interface ILabelProps {
  isHeader?: boolean;
  text: string;
  setText: (value: string) => void;
  isEditing: boolean;
  onSubmit: React.MutableRefObject<(target: EventTarget & HTMLInputElement) => void>;
  tooltip?: string;
}

const Label = (props: ILabelProps) =>
  props.isEditing ? (
    <input
      className="input"
      autoFocus
      type="text"
      defaultValue={props.text}
      onBlur={(e) => {
        const value = e.currentTarget.value.trim();
        if (value.length > 0) {
          props.setText(value);
        }
        props.onSubmit.current(e.currentTarget);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        const value = e.currentTarget.value.trim();
        if (e.key === 'Enter' && value.length > 0) {
          props.setText(value);
          props.onSubmit.current(e.currentTarget);
        } else if (e.key === 'Escape') {
          props.onSubmit.current(e.currentTarget); // cancel with escape
        }
      }}
      onFocus={(e) => e.target.select()}
      // Stop propagation so that the parent Tag element doesn't toggle selection status
      onClick={(e) => e.stopPropagation()}
    />
  ) : (
    <div
      className={`label-text ${props.isHeader ? 'label-header' : ''}`}
      data-tooltip={props.tooltip}
    >
      {props.text}
    </div>
  );

/**
 * Toggles Query
 *
 * All it does is remove the query if it already searched, otherwise adds a
 * query. Handling filter mode or replacing the search criteria list is up to
 * the component.
 */
export const toggleQuery = (nodeData: ClientTag, uiStore: UiStore) => {
  if (nodeData.isSearched) {
    // if it already exists, then remove it
    const alreadySearchedCrit = uiStore.searchCriteriaList.find((c) =>
      (c as ClientTagSearchCriteria).value?.includes(nodeData.id),
    );
    if (alreadySearchedCrit) {
      uiStore.replaceSearchCriterias(
        uiStore.searchCriteriaList.filter((c) => c !== alreadySearchedCrit),
      );
    }
  } else {
    uiStore.addSearchCriteria(new ClientTagSearchCriteria(undefined, 'tags', nodeData.id));
  }
};

export interface ITagItemProps {
  nodeData: ClientTag;
  dispatch: React.Dispatch<Action>;
  isEditing: boolean;
  submit: React.MutableRefObject<(target: EventTarget & HTMLInputElement) => void>;
  select: (event: React.MouseEvent, nodeData: ClientTag, expansion: IExpansionState) => void;
  pos: number;
  expansion: React.MutableRefObject<IExpansionState>;
}

export const TagItem = observer((props: ITagItemProps) => {
  const { nodeData, dispatch, expansion, isEditing, submit, pos, select } = props;
  const { uiStore } = useStore();
  const dndData = useTagDnD();

  const show = useContextMenu();
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) =>
      show(
        e.clientX,
        e.clientY,
        <TagItemContextMenu dispatch={dispatch} tag={nodeData} pos={pos} />,
      ),
    [dispatch, nodeData, pos, show],
  );

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      runInAction(() => {
        let name = nodeData.name;
        if (nodeData.isSelected) {
          const ctx = uiStore.getTagContextItems(nodeData.id);
          if (ctx.length === 1) {
            name = ctx[0].name;
          } else {
            const extraText = formatTagCountText(ctx.length);
            if (extraText.length > 0) {
              name += ` (${extraText})`;
            }
          }
        }
        DnDHelper.onDragStart(event, name, uiStore.theme, dndData, nodeData);
      });
    },
    [dndData, nodeData, uiStore],
  );

  // Don't expand immediately on drag-over, only after hovering over it for a second or so
  const expandTimeoutRef = useRef<number | undefined>();
  const expandDelayed = useCallback(
    (nodeData: ClientTag) => {
      if (expandTimeoutRef.current) {
        clearTimeout(expandTimeoutRef.current);
      }
      const t = window.setTimeout(() => {
        dispatch(Factory.expandNode(nodeData, nodeData.id));
        expandTimeoutRef.current = undefined;
      }, HOVER_TIME_TO_EXPAND);
      expandTimeoutRef.current = t;
    },
    [dispatch],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      runInAction(() => {
        if (
          (dndData.source?.isSelected && nodeData.isSelected) ||
          nodeData.isAncestor(dndData.source!)
        ) {
          return;
        }

        const isIgnored = DnDHelper.onDragOver(event, dndData);
        if (isIgnored) {
          return;
        }

        // Don't expand when hovering over top/bottom border
        const targetClasses = event.currentTarget.classList;
        if (targetClasses.contains('top') || targetClasses.contains('bottom')) {
          if (expandTimeoutRef.current) {
            clearTimeout(expandTimeoutRef.current);
            expandTimeoutRef.current = undefined;
          }
        } else if (!expansion.current[nodeData.id] && !expandTimeoutRef.current) {
          expandDelayed(nodeData);
        }
      });
    },
    [dndData, expandDelayed, expansion, nodeData],
  );

  const handleDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (runInAction(() => dndData.source !== undefined)) {
        DnDHelper.onDragLeave(event);

        if (expandTimeoutRef.current) {
          clearTimeout(expandTimeoutRef.current);
          expandTimeoutRef.current = undefined;
        }
      }
    },
    [dndData],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      runInAction(() => {
        const relativeMovePos = DnDHelper.onDrop(event);

        // Expand the tag if it's not already expanded
        if (!expansion.current[nodeData.id] && relativeMovePos === 'middle') {
          dispatch(Factory.setExpansion(nodeData, (val) => ({ ...val, [nodeData.id]: true })));
        }

        // Note to self: 'pos' does not start from 0! It is +1'd. So, here we -1 it again
        if (dndData.source?.isSelected) {
          if (relativeMovePos === 'middle') {
            uiStore.moveSelectedTagItems(nodeData.id);
          } else {
            uiStore.moveSelectedTagItems(nodeData.parent.id, pos + relativeMovePos);
          }
        } else if (dndData.source !== undefined) {
          if (relativeMovePos === 'middle') {
            nodeData.insertSubTag(dndData.source, 0);
          } else {
            nodeData.parent.insertSubTag(dndData.source, pos + relativeMovePos);
          }
        }
      });

      if (expandTimeoutRef.current) {
        clearTimeout(expandTimeoutRef.current);
        expandTimeoutRef.current = undefined;
      }
    },
    [dispatch, dndData, expansion, nodeData, pos, uiStore],
  );

  const handleSelect = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      select(event, nodeData, expansion.current);
    },
    [expansion, nodeData, select],
  );

  const handleQuickQuery = useCallback(
    (event: React.MouseEvent) => {
      runInAction(() => {
        event.stopPropagation();
        if (nodeData.isSearched) {
          // if already searched, un-search
          const crit = uiStore.searchCriteriaList.find(
            (c) => c instanceof ClientTagSearchCriteria && c.value === nodeData.id,
          );
          if (crit) {
            uiStore.removeSearchCriteria(crit);
          }
        } else {
          // otherwise, search it
          const query = new ClientTagSearchCriteria(
            undefined,
            'tags',
            nodeData.id,
            'containsRecursively',
          );
          if (event.ctrlKey || event.metaKey) {
            uiStore.addSearchCriteria(query);
          } else {
            uiStore.replaceSearchCriteria(query);
          }
        }
      });
    },
    [nodeData, uiStore],
  );

  const handleRename = useCallback(
    () => dispatch(Factory.enableEditing(nodeData, nodeData.id)),
    [dispatch, nodeData],
  );

  return (
    <div
      className="tree-content-label"
      draggable={!isEditing}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onContextMenu={handleContextMenu}
      onClick={handleSelect}
      onDoubleClick={handleRename}
    >
      <span style={{ color: nodeData.viewColor }}>
        {nodeData.isHidden ? IconSet.HIDDEN : IconSet.TAG}
      </span>
      <Label
        isHeader={nodeData.isHeader}
        text={nodeData.name}
        setText={nodeData.rename}
        isEditing={isEditing}
        onSubmit={submit}
        tooltip={`${nodeData.path
          .map((v) => (v.startsWith('#') ? '&nbsp;<b>' + v.slice(1) + '</b>&nbsp;' : v))
          .join(' › ')}${` (${nodeData.isFileCountDirty ? '~' : ''}${
          nodeData.fileCount === 0 && nodeData.isFileCountDirty ? '?' : nodeData.fileCount
        })`}`}
      />
      {!isEditing && (
        <SearchButton
          onClick={handleQuickQuery}
          isSearched={nodeData.isSearched}
          htmlTitle={nodeData.description}
        />
      )}
    </div>
  );
});
