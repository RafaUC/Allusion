import { action, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useReducer, useRef } from 'react';

import { formatTagCountText } from 'common/fmt';
import { IconSet } from 'widgets';
import MultiSplitPane, { MultiSplitPaneProps } from 'widgets/MultiSplit/MultiSplitPane';
import { useContextMenu } from 'widgets/menus';
import { Toolbar, ToolbarButton } from 'widgets/toolbar';
import {
  ITreeItem,
  TreeLabel,
  VirtualizedTree,
  VirtualizedTreeHandle,
  createBranchOnKeyDown,
  createLeafOnKeyDown,
} from 'widgets/tree';
import { ROOT_TAG_ID } from '../../../../api/tag';
import { TagRemoval } from '../../../components/RemovalAlert';
import { useStore } from '../../../contexts/StoreContext';
import { DnDTagType, useTagDnD } from '../../../contexts/TagDnDContext';
import { ClientTagSearchCriteria } from '../../../entities/SearchCriteria';
import { ClientTag } from '../../../entities/Tag';
import { useAction, useAutorun } from '../../../hooks/mobx';
import TagStore from '../../../stores/TagStore';
import UiStore from '../../../stores/UiStore';
import { IExpansionState } from '../../types';
import { HOVER_TIME_TO_EXPAND } from '../LocationsPanel/useFileDnD';
import { createDragReorderHelper } from '../TreeItemDnD';
import TreeItemRevealer, { ExpansionSetter, ScrollToItemPromise } from '../TreeItemRevealer';
import { TagItemContextMenu } from './ContextMenu';
import SearchButton from './SearchButton';
import { Action, Factory, Flag, State, reducer } from './state';
import { ID } from 'src/api/id';

export class TagsTreeItemRevealer extends TreeItemRevealer {
  public static readonly instance: TagsTreeItemRevealer = new TagsTreeItemRevealer();
  private constructor() {
    super();
    this.revealTag = action(this.revealTag.bind(this));
  }

  initialize(setExpansion: ExpansionSetter, scrollToItem: ScrollToItemPromise) {
    super.initializeExpansion(setExpansion, scrollToItem);
  }

  revealTag(tag: ClientTag) {
    const tagsToExpand = Array.from(tag.getAncestors(), (t) => t.id);
    tagsToExpand.push(ROOT_TAG_ID);
    this.revealTreeItem(tagsToExpand, tag);
  }
}

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
      // TODO: Visualizing errors...
      // Only show red outline when input field is in focus and text is invalid
    />
  ) : (
    <div
      className={`label-text ${props.isHeader ? 'label-header' : ''}`}
      data-tooltip={props.tooltip}
    >
      {props.text}
    </div>
  );

interface ITagItemProps {
  nodeData: ClientTag;
  dispatch: React.Dispatch<Action>;
  isEditing: boolean;
  submit: React.MutableRefObject<(target: EventTarget & HTMLInputElement) => void>;
  select: (event: React.MouseEvent, nodeData: ClientTag, expansion: IExpansionState) => void;
  pos: number;
  expansion: React.MutableRefObject<IExpansionState>;
}

/**
 * Toggles Query
 *
 * All it does is remove the query if it already searched, otherwise adds a
 * query. Handling filter mode or replacing the search criteria list is up to
 * the component.
 */
const toggleQuery = (nodeData: ClientTag, uiStore: UiStore) => {
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

const DnDHelper = createDragReorderHelper('tag-dnd-preview', DnDTagType);

const TagItem = observer((props: ITagItemProps) => {
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

interface ITreeData {
  state: State;
  dispatch: React.Dispatch<Action>;
  submit: React.MutableRefObject<(target: EventTarget & HTMLInputElement) => void>;
  select: (event: React.MouseEvent, nodeData: ClientTag, expansion: IExpansionState) => void;
}

const TagItemLabel: TreeLabel = ({
  nodeData,
  treeData,
  pos,
}: {
  nodeData: ClientTag;
  treeData: ITreeData;
  pos: number;
}) => {
  // Store expansion state in a Ref to prevent re-rendering all tree label components
  // when expanding or collapsing a single item.
  const expansionRef = useRef(treeData.state.expansion);
  useEffect(() => {
    expansionRef.current = treeData.state.expansion;
  }, [treeData.state.expansion]);

  return (
    <TagItem
      nodeData={nodeData}
      dispatch={treeData.dispatch}
      expansion={expansionRef}
      isEditing={treeData.state.editableNode === nodeData.id}
      submit={treeData.submit}
      pos={pos}
      select={treeData.select}
    />
  );
};

const isSelected = (nodeData: ClientTag): boolean => nodeData.isSelected;

const isExpanded = (nodeData: ClientTag, treeData: ITreeData): boolean =>
  !!treeData.state.expansion[nodeData.id];

const toggleExpansion = (nodeData: ClientTag, treeData: ITreeData, event?: React.MouseEvent) => {
  const isToggleRecursive = event !== undefined && (event.ctrlKey || event.metaKey);
  if (isToggleRecursive) {
    treeData.dispatch(
      Factory.setExpansion(nodeData, (prev) => {
        const isNodeExpanded = !!prev[nodeData.id];
        const newExpansionState = { ...prev };
        const subIds = runInAction(() => Array.from(nodeData.getSubTree(), (t) => t.id));
        for (const id of subIds) {
          newExpansionState[id] = !isNodeExpanded;
        }
        return newExpansionState;
      }),
    );
  } else {
    treeData.dispatch(Factory.toggleNode(nodeData, nodeData.id));
  }
};

const toggleSelection = (uiStore: UiStore, nodeData: ClientTag) =>
  uiStore.toggleTagSelection(nodeData);

const triggerContextMenuEvent = (event: React.KeyboardEvent<HTMLLIElement>) => {
  const element = event.currentTarget.querySelector('.tree-content-label');
  if (element !== null) {
    event.stopPropagation();
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent('contextmenu', {
        clientX: rect.right,
        clientY: rect.top,
        bubbles: true,
      }),
    );
  }
};

const customKeys = (
  uiStore: UiStore,
  tagStore: TagStore,
  event: React.KeyboardEvent<HTMLLIElement>,
  nodeData: ClientTag,
  treeData: ITreeData,
) => {
  switch (event.key) {
    case 'F2':
      event.stopPropagation();
      treeData.dispatch(Factory.enableEditing(nodeData, nodeData.id));
      break;

    case 'F10':
      if (event.shiftKey) {
        triggerContextMenuEvent(event);
      }
      break;

    case 'Enter':
      event.stopPropagation();
      toggleQuery(nodeData, uiStore);
      break;

    case 'Delete':
      treeData.dispatch(Factory.confirmDeletion(nodeData));
      break;

    case 'ContextMenu':
      triggerContextMenuEvent(event);
      break;

    default:
      break;
  }
};

function mapTag(tag: ClientTag, cache: Map<string, TreeNodeResult>): TreeNodeResult {
  const prev = cache.get(tag.id);

  if (prev !== undefined && prev.version === tag.subtreeVersion) {
    return prev;
  }

  const mappedChildren: ITreeItem[] = [];
  for (const subTag of tag.subTags) {
    const childResult = mapTag(subTag, cache);
    mappedChildren.push(childResult.node);
  }

  const newNode: ITreeItem = {
    id: tag.id,
    label: TagItemLabel,
    children: mappedChildren,
    nodeData: tag,
    isExpanded,
    isSelected,
  };

  const newResult: TreeNodeResult = { version: tag.subtreeVersion, node: newNode };
  cache.set(tag.id, newResult);
  return newResult;
}

type TreeNodeResult = {
  version: number;
  node: ITreeItem;
};

const useStableMappedTagTreeNodes = (root: ClientTag) => {
  const { uiStore } = useStore();
  const [, forceUpdate] = useReducer((x) => x + 1, 0);
  const cache = useRef(new Map<ID, TreeNodeResult>()).current;
  const prevSelection = useRef<ID[]>([]);
  const stableResultRef = useRef<ITreeItem[]>([]);

  // Since TreeBranch and TreeLeaf use the data inside a ITreeItem node as props
  // we can change the reference of any property of that node to ensure a re-render
  // and the best candidate is the children property, just re asign a shallow copy of it.
  /**
   * Marks the provided nodes to re-render their components and causes a re-render of the tree
   * @param nodes A list of node IDs to mark for re-render. The list must include all nodes in the path from any target node up to the root, to ensure that all affected branches are updated.
   */
  const triggerNodesUpdate = useRef((nodes: ID[]) => {
    const visited = new Set<ID>();
    for (let i = 0; i < nodes.length; i++) {
      const nodeId = nodes[i];
      if (!visited.has(nodeId)) {
        visited.add(nodeId);
        const node = cache.get(nodeId);
        if (node !== undefined) {
          node.node.children = node.node.children.slice();
        }
      }
    }
    stableResultRef.current = stableResultRef.current.slice();
    forceUpdate();
  }).current;

  // Observes tag selection changes and updates the necessary nodes to reflect
  // the current selection state.
  useAutorun(() => {
    const visited = new Set<ClientTag>();
    const nodeIds: ID[] = [];
    for (const tag of uiStore.tagSelection) {
      for (const ancestor of tag.getAncestors(visited)) {
        nodeIds.push(ancestor.id);
      }
    }
    const prevIds = prevSelection.current;
    prevSelection.current = nodeIds;
    triggerNodesUpdate(prevIds.concat(nodeIds));
  });

  // Observes all tag branches in the hierarchy and updates any nodes that are
  // outdated or necesary for the update to take effect.
  useAutorun(() => {
    const stable = stableResultRef.current;
    for (let i = 0; i < root.subTags.length; i++) {
      const tag = root.subTags[i];
      const prev = cache.get(tag.id);
      if (
        stable[i]?.nodeData !== tag ||
        !(prev !== undefined && prev.version === tag.subtreeVersion)
      ) {
        stable[i] = mapTag(tag, cache).node;
      }
    }
    // Remove extra stale entries
    stable.length = root.subTags.length;
    stableResultRef.current = stableResultRef.current.slice();
    forceUpdate();
  });

  return { treeNodes: stableResultRef.current, triggerNodeUpdate: triggerNodesUpdate };
};

const TagsTree = observer((props: Partial<MultiSplitPaneProps>) => {
  const { tagStore, uiStore } = useStore();
  const root = tagStore.root;
  const [state, dispatchFn] = useReducer(reducer, {
    expansion: {},
    editableNode: undefined,
    deletableNode: undefined,
  });
  const dndData = useTagDnD();
  const vTreeRef = useRef<VirtualizedTreeHandle>(null);

  //// Children update and re-render control ///
  const { treeNodes: children, triggerNodeUpdate } = useStableMappedTagTreeNodes(root);

  /**
   * Dispatch wrapper that takes an action and updates the affected TreeItem and it's ancestors
   * children array references to trigger re-renders only for those nodes.
   */
  const dispatch = useCallback(
    (action: Action) => {
      const source = action.data.source;
      if (source !== undefined) {
        const ancestorsIds = runInAction(() => Array.from(source.getAncestors(), (t) => t.id));
        triggerNodeUpdate(ancestorsIds);
      }
      dispatchFn(action);
      // When inserting a new node or enabling editing, scroll the item into view.
      // A delay is added to allow node expansion to take effect first.
      if (action.flag === Flag.InsertNode || action.flag === Flag.EnableEditing) {
        setTimeout(
          () => vTreeRef.current?.scrollToItemById(source?.id ?? '', 'smart', 'auto'),
          300,
        );
      }
    },
    [triggerNodeUpdate],
  );

  ////

  useEffect(() => {
    TagsTreeItemRevealer.instance.initialize(
      (
        val: IExpansionState | ((prevState: IExpansionState) => IExpansionState),
        source?: ClientTag,
      ) => {
        dispatch(Factory.setExpansion(source, val));
      },
      (dataId: string) => vTreeRef.current?.scrollToItemById(dataId) ?? Promise.resolve(),
    );
  }, [dispatch]);

  /** Header and Footer drop zones of the root node */
  const handleDragOverAndLeave = useAction((event: React.DragEvent<HTMLDivElement>) => {
    if (dndData.source !== undefined) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  const submit = useRef((target: EventTarget & HTMLInputElement) => {
    void target;
  });
  useEffect(() => {
    submit.current = (target: EventTarget & HTMLInputElement) => {
      target.focus();
      dispatch(Factory.disableEditing(tagStore.get(state.editableNode ?? '')));
      target.setSelectionRange(0, 0);
    };
  }, [dispatch, state.editableNode, tagStore]);

  /** The first item that is selected in a multi-selection */
  const initialSelectionIndex = useRef<number>();
  /** The last item that is selected in a multi-selection */
  const lastSelectionIndex = useRef<number>();
  // Handles selection via click event
  const select = useAction((e: React.MouseEvent, selectedTag: ClientTag, exp: IExpansionState) => {
    // Note: selection logic is copied from Gallery.tsx
    // update: Added shallow/only-expanded and deep/sub-tree selection behavior
    const rangeSelection = e.shiftKey;
    const expandSelection = e.ctrlKey || e.metaKey;
    const deepSelection = e.altKey;

    /** The index of the active (newly selected) item */
    const i = tagStore.findFlatTagListIndex(selectedTag);

    // If nothing is selected, initialize the selection range and select that single item
    if (lastSelectionIndex.current === undefined) {
      initialSelectionIndex.current = i;
      lastSelectionIndex.current = i;
      uiStore.toggleTagSelection(selectedTag);
      return;
    }

    // Mark this index as the last item that was selected
    lastSelectionIndex.current = i;

    if (rangeSelection && initialSelectionIndex.current !== undefined) {
      if (i === undefined) {
        return;
      }
      if (i < initialSelectionIndex.current) {
        uiStore.selectTagRange(
          i,
          initialSelectionIndex.current,
          expandSelection,
          deepSelection ? undefined : exp,
        );
      } else {
        uiStore.selectTagRange(
          initialSelectionIndex.current,
          i,
          expandSelection,
          deepSelection ? undefined : exp,
        );
      }
    } else if (expandSelection) {
      if (deepSelection) {
        const select = !selectedTag.isSelected;
        const subtags = selectedTag.getSubTree();
        if (select) {
          for (const subtag of subtags) {
            uiStore.selectTag(subtag);
          }
        } else {
          for (const subtag of subtags) {
            uiStore.deselectTag(subtag);
          }
        }
      } else {
        uiStore.toggleTagSelection(selectedTag);
      }
      initialSelectionIndex.current = i;
    } else {
      if (selectedTag.isSelected && uiStore.tagSelection.size === 1) {
        uiStore.clearTagSelection();
        (document.activeElement as HTMLElement | null)?.blur();
      } else {
        if (deepSelection) {
          uiStore.clearTagSelection();
          const subtags = selectedTag.getSubTree();
          for (const subtag of subtags) {
            uiStore.selectTag(subtag);
          }
        } else {
          uiStore.selectTag(selectedTag, true);
        }
      }
      initialSelectionIndex.current = i;
    }
  });

  const treeData: ITreeData = useRef({
    state,
    dispatch,
    submit: submit,
    select,
  }).current;
  treeData.state = state;
  treeData.dispatch = dispatch;
  treeData.select = select;

  const handleRootAddTag = useAction(() =>
    tagStore
      .create(tagStore.root, 'New Tag')
      .then((tag) => dispatch(Factory.enableEditing(tag, tag.id)))
      .catch((err) => console.log('Could not create tag', err)),
  );

  const handleDrop = useAction(() => {
    if (dndData.source?.isSelected) {
      uiStore.moveSelectedTagItems(ROOT_TAG_ID);
    } else if (dndData.source !== undefined) {
      const { root } = tagStore;
      root.insertSubTag(dndData.source, root.subTags.length);
    }
  });

  const handleScrollOnKeyDown = useAction(
    (event: React.KeyboardEvent<HTMLLIElement>, nodeData: ClientTag) => {
      let offset = 0;
      switch (event.key) {
        case 'ArrowDown':
          offset = 1;
          break;
        case 'ArrowUp':
          offset = -1;
          break;
        default:
          return;
      }
      vTreeRef.current?.scrollToItemById(nodeData.id, 'smart', 'auto', offset);
    },
  );

  const handleBranchOnKeyDown = useAction(
    (event: React.KeyboardEvent<HTMLLIElement>, nodeData: ClientTag, treeData: ITreeData) => {
      handleScrollOnKeyDown(event, nodeData);
      createBranchOnKeyDown(
        event,
        nodeData,
        treeData,
        isExpanded,
        toggleSelection.bind(null, uiStore),
        toggleExpansion,
        customKeys.bind(null, uiStore, tagStore),
      );
    },
  );

  const handleLeafOnKeyDown = useAction(
    (event: React.KeyboardEvent<HTMLLIElement>, nodeData: ClientTag, treeData: ITreeData) => {
      handleScrollOnKeyDown(event, nodeData);
      createLeafOnKeyDown(
        event,
        nodeData,
        treeData,
        toggleSelection.bind(null, uiStore),
        customKeys.bind(null, uiStore, tagStore),
      );
    },
  );

  const handleKeyDown = useAction((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      uiStore.clearTagSelection();
      (document.activeElement as HTMLElement | null)?.blur();
      e.stopPropagation();
    } else {
      props.onKeyDown?.(e);
    }
  });

  return (
    <MultiSplitPane
      id="tags"
      title="Tags"
      onKeyDown={handleKeyDown}
      headerProps={{
        onDragOver: handleDragOverAndLeave,
        onDragLeave: handleDragOverAndLeave,
        onDrop: handleDrop,
      }}
      headerToolbar={
        <Toolbar controls="tag-hierarchy" isCompact>
          {!tagStore.fileCountsInitialized && (
            <ToolbarButton
              icon={IconSet.RELOAD_COMPACT}
              text="Update Tag File Counts"
              onClick={() => tagStore.updateTagSubTreeFileCounts(root)}
              tooltip={'Update Tag File Counts'}
            />
          )}
          {uiStore.tagSelection.size > 0 ? (
            <ToolbarButton
              icon={IconSet.CLOSE}
              text="Clear"
              onClick={uiStore.clearTagSelection}
              tooltip="Clear Selection"
            />
          ) : (
            <ToolbarButton
              icon={IconSet.PLUS}
              text="New Tag"
              onClick={handleRootAddTag}
              tooltip="Add a new tag"
            />
          )}
        </Toolbar>
      }
      {...props}
    >
      {root.subTags.length === 0 ? (
        <div className="tree-content-label" style={{ padding: '0.25rem' }}>
          {/* <span className="pre-icon">{IconSet.INFO}</span> */}
          {/* No tags or collections created yet */}
          <i style={{ marginLeft: '1em' }}>None</i>
        </div>
      ) : (
        <VirtualizedTree
          ref={vTreeRef}
          multiSelect
          id="tag-hierarchy"
          className={uiStore.tagSelection.size > 0 ? 'selected' : undefined}
          children={children}
          treeData={treeData}
          toggleExpansion={toggleExpansion}
          onBranchKeyDown={handleBranchOnKeyDown}
          onLeafKeyDown={handleLeafOnKeyDown}
          footer={
            /* Used for dragging collection to root of hierarchy and for deselecting tag selection */
            <div
              id="tree-footer"
              onClick={uiStore.clearTagSelection}
              onDragOver={handleDragOverAndLeave}
              onDragLeave={handleDragOverAndLeave}
              onDrop={handleDrop}
            />
          }
        />
      )}

      {state.deletableNode && (
        <TagRemoval
          object={state.deletableNode}
          onClose={() => dispatch(Factory.abortDeletion())}
        />
      )}
    </MultiSplitPane>
  );
});

export default TagsTree;
