import { observable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import React, { useCallback, useMemo, useRef, useState } from 'react';

import MultiSplitPane, { MultiSplitPaneProps } from 'widgets/MultiSplit/MultiSplitPane';
import { IconSet } from 'widgets/icons';
import { Menu, MenuItem, useContextMenu } from 'widgets/menus';
import { Callout } from 'widgets/notifications';
import { Toolbar, ToolbarButton } from 'widgets/toolbar';
import Tree, { ITreeItem, createBranchOnKeyDown } from 'widgets/tree';
import { generateId } from '../../../../api/id';
import { SavedSearchRemoval } from '../../../components/RemovalAlert';
import { useStore } from '../../../contexts/StoreContext';
import { DnDSearchType, SearchDnDProvider, useSearchDnD } from '../../../contexts/TagDnDContext';
import { ClientFileSearchCriteria, CustomKeyDict } from '../../../entities/SearchCriteria';
import {
  ClientFileSearchItem,
  ClientSearchGroup,
  isClientSearchGroup,
} from '../../../entities/SearchItem';
import { useAutorun } from '../../../hooks/mobx';
import SearchItemDialog from '../../AdvancedSearch/SearchItemDialog';
import { IExpansionState } from '../../types';
import { createDragReorderHelper } from '../TreeItemDnD';
import { triggerContextMenuEvent } from '../utils';

// Tooltip info
const enum Tooltip {
  Create = 'Save the current search as a new saved search',
}

interface ITreeData {
  expansion: IExpansionState;
  setExpansion: React.Dispatch<IExpansionState>;
  delete: (location: ClientFileSearchItem) => void;
  edit: (location: ClientFileSearchItem) => void;
  duplicate: (location: ClientFileSearchItem) => void;
  replace: (location: ClientFileSearchItem) => void;
}

const toggleExpansion = (nodeData: ClientFileSearchItem, treeData: ITreeData) => {
  const { expansion, setExpansion } = treeData;
  const id = nodeData.id;
  setExpansion({ ...expansion, [id]: !expansion[id] });
};

const isExpanded = (nodeData: ClientFileSearchItem, treeData: ITreeData) =>
  !!treeData.expansion[nodeData.id];

const customKeys = (
  search: (crits: ClientFileSearchCriteria[] | ClientSearchGroup, searchMatchAny: boolean) => void,
  event: React.KeyboardEvent<HTMLLIElement>,
  nodeData: ClientFileSearchItem | ClientFileSearchCriteria,
  treeData: ITreeData,
) => {
  switch (event.key) {
    case 'F10':
      if (event.shiftKey) {
        triggerContextMenuEvent(event);
      }
      break;

    case 'Enter':
      event.stopPropagation();
      if (nodeData instanceof ClientFileSearchItem) {
        search(nodeData.rootGroup, nodeData.rootGroup.conjunction === 'or');
      } else {
        // TODO: ctrl/shift adds onto search
        search([nodeData], false);
      }
      break;

    case 'Delete':
      if (nodeData instanceof ClientFileSearchItem) {
        event.stopPropagation();
        treeData.delete(nodeData);
      }
      break;

    case 'ContextMenu':
      triggerContextMenuEvent(event);
      break;

    default:
      break;
  }
};

const SearchItemNodeLabel = ({ nodeData, treeData }: { nodeData: any; treeData: any }) => (
  <SearchItemNode nodeData={nodeData} treeData={treeData} />
);

const SearchItemLabel = ({ nodeData, treeData }: { nodeData: any; treeData: any }) => (
  <SearchItem nodeData={nodeData} treeData={treeData} />
);

const mapNode = (node: ClientFileSearchCriteria | ClientSearchGroup): ITreeItem => {
  return {
    id: `${node.id}`,
    nodeData: node,
    label: SearchItemNodeLabel,
    children: isClientSearchGroup(node) ? node.children.map((ch) => mapNode(ch)) : [],
    isExpanded,
  };
};

const mapItem = (item: ClientFileSearchItem): ITreeItem => ({
  id: item.id,
  label: SearchItemLabel,
  nodeData: item,
  children: item.rootGroup.children.map((ch) => mapNode(ch)),
  isExpanded,
});

interface IContextMenuProps {
  searchItem: ClientFileSearchItem;
  onEdit: (searchItem: ClientFileSearchItem) => void;
  onDuplicate: (searchItem: ClientFileSearchItem) => void;
  onReplace: (searchItem: ClientFileSearchItem) => void;
  onDelete: (searchItem: ClientFileSearchItem) => void;
}

const SearchItemContextMenu = observer(
  ({ searchItem, onDelete, onDuplicate, onReplace, onEdit }: IContextMenuProps) => {
    return (
      <Menu>
        <MenuItem text="Edit" onClick={() => onEdit(searchItem)} icon={IconSet.EDIT} />
        <MenuItem
          text="Replace with current search"
          onClick={() => onReplace(searchItem)}
          icon={IconSet.REPLACE}
        />
        <MenuItem text="Duplicate" onClick={() => onDuplicate(searchItem)} icon={IconSet.PLUS} />
        <MenuItem text="Delete" onClick={() => onDelete(searchItem)} icon={IconSet.DELETE} />
      </Menu>
    );
  },
);

const DnDHelper = createDragReorderHelper('saved-searches-dnd-preview', DnDSearchType);

const SearchItem = observer(
  ({ nodeData, treeData }: { nodeData: ClientFileSearchItem; treeData: ITreeData }) => {
    const rootStore = useStore();
    const { uiStore, searchStore } = rootStore;
    const { edit: onEdit, duplicate: onDuplicate, delete: onDelete, replace: onReplace } = treeData;
    const show = useContextMenu();
    const handleContextMenu = useCallback(
      (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
        show(
          event.clientX,
          event.clientY,
          <SearchItemContextMenu
            searchItem={nodeData}
            onEdit={onEdit}
            onDelete={onDelete}
            onDuplicate={onDuplicate}
            onReplace={onReplace}
          />,
        );
      },
      [show, nodeData, onEdit, onDelete, onDuplicate, onReplace],
    );

    const handleClick = useCallback(
      (e: React.MouseEvent) => {
        runInAction(() => {
          if (!e.ctrlKey) {
            uiStore.replaceSearchCriterias(nodeData.rootGroup);
          } else {
            uiStore.toggleSearchCriterias(nodeData.rootGroup);
          }
        });
      },
      [nodeData.rootGroup, uiStore],
    );

    const handleEdit = useCallback(
      (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        treeData.edit(nodeData);
      },
      [nodeData, treeData],
    );

    const dndData = useSearchDnD();
    const handleDragStart = useCallback(
      (event: React.DragEvent<HTMLDivElement>) =>
        runInAction(() =>
          DnDHelper.onDragStart(event, nodeData.name, uiStore.theme, dndData, nodeData),
        ),
      [dndData, nodeData, uiStore],
    );

    const handleDragOver = useCallback(
      (event: React.DragEvent<HTMLDivElement>) => DnDHelper.onDragOver(event, dndData, false),
      [dndData],
    );

    const handleDragLeave = useCallback(
      (event: React.DragEvent<HTMLDivElement>) => DnDHelper.onDragLeave(event),
      [],
    );

    const handleDrop = useCallback(
      (event: React.DragEvent<HTMLDivElement>) => {
        runInAction(() => {
          if (!dndData.source) {
            return;
          }
          const relativeMovePos = DnDHelper.onDrop(event);

          if (relativeMovePos === 'middle') {
            // not possible for searches, no middle position allowed
          } else {
            let target = nodeData;
            if (relativeMovePos === -1) {
              const index = searchStore.searchList.indexOf(target) - 1;
              if (index >= 0) {
                target = searchStore.searchList[index];
              }
            }
            searchStore.reorder(dndData.source, target);
          }
        });
      },
      [dndData.source, nodeData, searchStore],
    );

    return (
      <div
        className="tree-content-label"
        onClick={handleClick}
        draggable
        onContextMenu={handleContextMenu}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* {IconSet.SEARCH} */}
        {nodeData.rootGroup.conjunction === 'or' ? IconSet.SEARCH_ANY : IconSet.SEARCH_ALL}
        <div className="label-text">{nodeData.name}</div>

        <button className="btn btn-icon" onClick={handleEdit}>
          {IconSet.EDIT}
        </button>
      </div>
    );
  },
);

interface SearchItemCriteriaProps {
  nodeData: ClientFileSearchCriteria | ClientSearchGroup;
  treeData: ITreeData;
}

const SearchItemNode = observer(({ nodeData }: SearchItemCriteriaProps) => {
  const rootStore = useStore();
  const { uiStore } = rootStore;

  // TODO: context menu for individual criteria of search items?

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      runInAction(() => {
        let ndata: ClientSearchGroup | ClientFileSearchCriteria[] = [];
        if (isClientSearchGroup(nodeData)) {
          ndata = nodeData;
        } else {
          ndata = [nodeData];
        }
        if (!e.ctrlKey) {
          uiStore.replaceSearchCriterias(ndata);
        } else {
          uiStore.toggleSearchCriterias(ndata);
        }
      });
    },
    [nodeData, uiStore],
  );

  const label = isClientSearchGroup(nodeData)
    ? nodeData.name
      ? nodeData.name
      : nodeData
          .getLabels(CustomKeyDict, rootStore)
          .map((l) => l.label)
          .join(', ')
    : nodeData.getLabel(CustomKeyDict, rootStore);

  return (
    <div
      className="tree-content-label"
      onClick={handleClick}
      // onContextMenu={handleContextMenu}
    >
      {isClientSearchGroup(nodeData)
        ? nodeData.conjunction === 'or'
          ? IconSet.SEARCH_ANY
          : IconSet.SEARCH_ALL
        : nodeData.valueType === 'array'
        ? IconSet.TAG
        : nodeData.valueType === 'string'
        ? IconSet.FILTER_NAME_DOWN
        : nodeData.valueType === 'number'
        ? IconSet.FILTER_FILTER_DOWN
        : IconSet.FILTER_DATE}
      <div className="label-text" data-tooltip={label}>
        {label}
      </div>
    </div>
  );
});

interface ISearchTreeProps {
  onEdit: (search: ClientFileSearchItem) => void;
  onDelete: (search: ClientFileSearchItem) => void;
  onDuplicate: (search: ClientFileSearchItem) => void;
  onReplace: (search: ClientFileSearchItem) => void;
}

const SavedSearchesList = ({ onDelete, onEdit, onDuplicate, onReplace }: ISearchTreeProps) => {
  const rootStore = useStore();
  const { searchStore, uiStore } = rootStore;
  const [expansion, setExpansion] = useState<IExpansionState>({});
  const treeData: ITreeData = useMemo<ITreeData>(
    () => ({
      expansion,
      setExpansion,
      delete: onDelete,
      edit: onEdit,
      duplicate: onDuplicate,
      replace: onReplace,
    }),
    [expansion, onDelete, onDuplicate, onEdit, onReplace],
  );
  const [branches, setBranches] = useState<ITreeItem[]>([]);

  const handleBranchKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLLIElement>,
      nodeData: ClientFileSearchItem | ClientFileSearchCriteria,
      treeData: ITreeData,
    ) =>
      createBranchOnKeyDown(
        event,
        nodeData,
        treeData,
        isExpanded,
        () => {},
        toggleExpansion,
        customKeys.bind(
          null,
          (crits: ClientFileSearchCriteria[] | ClientSearchGroup, searchMatchAny: boolean) => {
            uiStore.replaceSearchCriterias(crits);
            if (uiStore.searchMatchAny !== searchMatchAny) {
              uiStore.toggleSearchMatchAny();
            }
          },
        ),
      ),
    [uiStore],
  );

  useAutorun(() => {
    setBranches(searchStore.searchList.map(mapItem));
  });

  // TODO: we probably need drag n drop re-ordering here too, god damnit
  // what would be a good way to store the order?
  // - Add an `index` field to the search item? will get messy, will need to redistribute all indices in certain cases...
  // - Store order separately in localstorage? Would be easiest, but hacky. Need to keep them in sync
  // same thing applies for Locations
  return (
    <Tree
      id="saved-searches-list"
      multiSelect
      children={branches}
      treeData={treeData}
      toggleExpansion={toggleExpansion}
      onBranchKeyDown={handleBranchKeyDown}
    />
  );
};

const SavedSearchesPanel = observer((props: Partial<MultiSplitPaneProps>) => {
  const rootStore = useStore();
  const { searchStore, uiStore } = rootStore;

  const isEmpty = searchStore.searchList.length === 0;

  const [editableSearch, setEditableSearch] = useState<ClientFileSearchItem>();
  const [deletableSearch, setDeletableSearch] = useState<ClientFileSearchItem>();

  const saveCurrentSearch = async () => {
    const savedSearch = await searchStore.create(
      runInAction(() => {
        return new ClientFileSearchItem(
          generateId(),
          uiStore.searchRootGroup
            .getLabels(CustomKeyDict, rootStore)
            .map((label) => label.label)
            .join(', ') || 'New search',
          uiStore.searchRootGroup.serialize(rootStore, true),
          searchStore.searchList.length,
        );
      }),
    );
    setEditableSearch(savedSearch);
  };

  const data = useRef(observable({ source: undefined }));

  return (
    <SearchDnDProvider value={data.current}>
      <MultiSplitPane
        id="saved-searches"
        title="Saved Searches"
        headerToolbar={
          <Toolbar controls="saved-searches-list" isCompact>
            <ToolbarButton
              icon={IconSet.PLUS}
              text="Save current search"
              onClick={saveCurrentSearch}
              tooltip={Tooltip.Create}
            />
          </Toolbar>
        }
        {...props}
      >
        <SavedSearchesList
          onEdit={setEditableSearch}
          onDelete={setDeletableSearch}
          onDuplicate={searchStore.duplicate}
          onReplace={searchStore.replaceWithActiveSearch}
        />
        {isEmpty && (
          <Callout icon={IconSet.INFO}>Click + to save your current search criteria.</Callout>
        )}

        {editableSearch && (
          <SearchItemDialog
            searchItem={editableSearch}
            onClose={() => setEditableSearch(undefined)}
          />
        )}
        {deletableSearch && (
          <SavedSearchRemoval
            object={deletableSearch}
            onClose={() => setDeletableSearch(undefined)}
          />
        )}
      </MultiSplitPane>
    </SearchDnDProvider>
  );
});

export default SavedSearchesPanel;
