import { observer } from 'mobx-react-lite';
import React, {
  ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { useStore } from '../../contexts/StoreContext';
const SEARCHBAR_ID = 'toolbar-searchbar';

const Searchbar = observer(() => {
  const { uiStore } = useStore();
  const searchCriteriaList = uiStore.searchRootGroup.children;

  // Only show quick search bar when all criteria are tags,
  // otherwise show a search bar that opens to the advanced search form
  // Exception: Searching for untagged files (tag contains empty value)
  // -> show as custom label in CriteriaList
  const isQuickSearch =
    searchCriteriaList.length === 0 ||
    searchCriteriaList.every(
      (crit) =>
        crit instanceof ClientTagSearchCriteria &&
        crit.key === 'tags' &&
        crit.operator === 'containsRecursively' &&
        (crit as ClientTagSearchCriteria).value,
    );

  return (
    <div id={SEARCHBAR_ID} className="searchbar">
      {isQuickSearch ? <QuickSearchList /> : <CriteriaList />}
    </div>
  );
});

export default Searchbar;

import {
  ClientExtraPropertySearchCriteria,
  ClientNumberSearchCriteria,
  ClientStringSearchCriteria,
  ClientTagSearchCriteria,
  CustomKeyDict,
} from 'src/frontend/entities/SearchCriteria';
import { ClientTag } from 'src/frontend/entities/Tag';

import { IconButton, IconSet, Row, Tag } from 'widgets';

import { TagSelector } from 'src/frontend/components/TagSelector';
import { useAction, useComputed } from 'src/frontend/hooks/mobx';
import { ExtraPropertySelector } from 'src/frontend/components/ExtraPropertySelector';
import { ClientExtraProperty } from 'src/frontend/entities/ExtraProperty';
import { ExtraPropertyType, getExtraPropertyDefaultValue } from 'src/api/extraProperty';
import { OperatorType } from 'src/api/search-criteria';
import { usePopover } from 'widgets/popovers/usePopover';
import { RowProps } from 'widgets/combobox/Grid';
import ReactDOM from 'react-dom';
import { BYTES_IN_MB, FileKeyOptions, Key, QuickSearchKeyOptions } from '../AdvancedSearch/data';
import { MenuButton, MenuItem } from 'widgets/menus';

const QuickSearchList = observer(() => {
  const { uiStore, tagStore } = useStore();
  const [selectedKey, setSelectedKey] = useState<Key>(
    () => (localStorage.getItem('quick_search_key') as Key | undefined) ?? 'tags',
  );

  // save setting in localStorage
  useEffect(() => {
    localStorage.setItem('quick_search_key', selectedKey);
  }, [selectedKey]);

  const selection = useComputed(() => {
    const selectedItems: ClientTag[] = [];
    uiStore.searchCriteriaList.forEach((c) => {
      if (c instanceof ClientTagSearchCriteria && c.value) {
        const item = tagStore.get(c.value);
        if (item) {
          selectedItems.push(item);
        }
      }
    });
    return selectedItems;
  });

  const handleSelect = useAction((item: Readonly<ClientTag>) =>
    uiStore.addSearchCriteria(
      new ClientTagSearchCriteria(undefined, 'tags', item.id, 'containsRecursively'),
    ),
  );

  const handleDeselect = useAction((item: Readonly<ClientTag>) => {
    const crit = uiStore.searchCriteriaList.find(
      (c) => c instanceof ClientTagSearchCriteria && c.value === item.id,
    );
    if (crit) {
      uiStore.removeSearchCriteria(crit);
    }
  });

  const ingnoreOnBlur = useRef((e: React.FocusEvent): boolean => {
    const searchbar = document.getElementById(SEARCHBAR_ID);
    if (searchbar) {
      return searchbar.contains(e.relatedTarget as Node);
    }
    return false;
  }).current;

  const forceCreateOption = selectedKey !== 'tags';

  /*useEffect(() => {
    if (forceCreateOption === true) {
      uiStore.clearSearchCriteriaTree();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceCreateOption]);*/

  const handleSetCreateOption: React.Dispatch<React.SetStateAction<boolean>> = (val) => {
    let newVal = forceCreateOption;
    if (typeof val === 'function') {
      newVal = val(newVal);
    } else {
      newVal = val;
    }
    setSelectedKey(newVal ? (selectedKey === 'tags' ? 'absolutePath' : selectedKey) : 'tags');
  };

  const renderCreateOption = useCallback(
    (query: string, resetTextBox: () => void): ReactElement<RowProps>[] => {
      const parsedNumber = parseFloat(query);
      const isValidNumber = !isNaN(parsedNumber);

      // Handler helper para las opciones deshabilitadas (previene que el evento cierre el menú)
      const handleDisabledClick = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
      };

      const options: Array<{
        key: string;
        component: (index: number) => ReactElement<RowProps>;
      }> = [
        {
          key: 'tags',
          component: (index: number) => (
            <Row
              id="search-in-tags-option"
              index={index}
              key="search-in-tags"
              value={`Search for tag "${query}"`}
              onClick={() => {
                resetTextBox();
                uiStore.addSearchCriteria(new ClientTagSearchCriteria(undefined, 'tags', query));
              }}
            />
          ),
        },
        {
          key: 'name',
          component: (index: number) => (
            <Row
              id="search-in-name-option"
              index={index}
              key="search-in-name"
              value={`Search in file names for "${query}"`}
              onClick={() => {
                resetTextBox();
                uiStore.addSearchCriteria(new ClientStringSearchCriteria(undefined, 'name', query));
              }}
            />
          ),
        },
        {
          key: 'extension',
          component: (index: number) => (
            <Row
              id="search-in-extension-option"
              index={index}
              key="search-in-extension"
              value={`Search for extension ".${query.replace(/^\./, '')}"`}
              onClick={() => {
                resetTextBox();
                uiStore.addSearchCriteria(
                  new ClientStringSearchCriteria(undefined, 'extension', query.replace(/^\./, '')),
                );
              }}
            />
          ),
        },
        {
          key: 'absolutePath',
          component: (index: number) => (
            <Row
              id="search-in-path-option"
              index={index}
              key="search-in-path"
              value={`Search in file paths for "${query}"`}
              onClick={() => {
                resetTextBox();
                uiStore.addSearchCriteria(
                  new ClientStringSearchCriteria(undefined, 'absolutePath', query),
                );
              }}
            />
          ),
        },
        {
          key: 'size',
          component: (index: number) => (
            <Row
              id="search-in-size-option"
              index={index}
              key="search-in-size"
              className={!isValidNumber ? 'disabled' : undefined}
              style={!isValidNumber ? { cursor: 'not-allowed', opacity: 0.5 } : undefined}
              value={
                isValidNumber
                  ? `Search for size "${parsedNumber} MB"`
                  : `Search for size "${query}" (invalid value)`
              }
              onClick={(e) => {
                if (!isValidNumber) {
                  handleDisabledClick(e);
                  return;
                }
                resetTextBox();
                uiStore.addSearchCriteria(
                  new ClientNumberSearchCriteria(undefined, 'size', parsedNumber * BYTES_IN_MB),
                );
              }}
            />
          ),
        },
        {
          key: 'width',
          component: (index: number) => (
            <Row
              id="search-in-width-option"
              index={index}
              key="search-in-width"
              className={!isValidNumber ? 'disabled' : undefined}
              style={!isValidNumber ? { cursor: 'not-allowed', opacity: 0.5 } : undefined}
              value={
                isValidNumber
                  ? `Search for width "${parsedNumber} px"`
                  : `Search for width "${query}" (invalid value)`
              }
              onClick={(e) => {
                if (!isValidNumber) {
                  handleDisabledClick(e);
                  return;
                }
                resetTextBox();
                uiStore.addSearchCriteria(
                  new ClientNumberSearchCriteria(undefined, 'width', parsedNumber),
                );
              }}
            />
          ),
        },
        {
          key: 'height',
          component: (index: number) => (
            <Row
              id="search-in-height-option"
              index={index}
              key="search-in-height"
              className={!isValidNumber ? 'disabled' : undefined}
              style={!isValidNumber ? { cursor: 'not-allowed', opacity: 0.5 } : undefined}
              value={
                isValidNumber
                  ? `Search for height "${parsedNumber} px"`
                  : `Search for height "${query}" (invalid value)`
              }
              onClick={(e) => {
                if (!isValidNumber) {
                  handleDisabledClick(e);
                  return;
                }
                resetTextBox();
                uiStore.addSearchCriteria(
                  new ClientNumberSearchCriteria(undefined, 'height', parsedNumber),
                );
              }}
            />
          ),
        },
        {
          key: 'extraProperties',
          component: (index: number) => (
            <QuickExtraPropertySearchOption
              key="search-in-extra-property"
              id="search-in-extra-property-option"
              index={index}
              value={`Search for "${query}" in an extra property`}
              query={query}
              resetTextBox={resetTextBox}
            />
          ),
        },
        {
          key: 'advanced',
          component: (index: number) => (
            <Row
              id="advanced-search-option"
              index={index}
              key="advanced-search"
              value="Advanced search"
              onClick={uiStore.toggleAdvancedSearch}
              icon={IconSet.SEARCH_EXTENDED}
            />
          ),
        },
      ];

      const sortedOptions = [...options].sort((a, b) => {
        if (a.key === selectedKey) {
          return -1;
        }
        if (b.key === selectedKey) {
          return 1;
        }
        return 0;
      });

      return sortedOptions.map((option, sortedIndex) =>
        option.component(sortedIndex),
      ) as ReactElement<RowProps>[];
    },
    [selectedKey, uiStore],
  );

  return (
    <TagSelector
      selection={selection.get()}
      onSelect={handleSelect}
      onDeselect={handleDeselect}
      onTagClick={uiStore.toggleAdvancedSearch}
      onClear={uiStore.clearSearchCriteriaTree}
      ignoreOnBlur={ingnoreOnBlur}
      renderCreateOption={renderCreateOption}
      forceCreateOption={selectedKey !== 'tags'}
      setForceCreateOption={handleSetCreateOption}
      extraIconButtons={
        <>
          <SearchDefaultTypeButton selectedKey={selectedKey} setSelectedKey={setSelectedKey} />
          <SearchMatchButton disabled={selection.get().length < 2} />
        </>
      }
    />
  );
});

type QuickEPOption = RowProps & {
  query: string;
  resetTextBox: () => void;
  index: number;
};

const QuickExtraPropertySearchOption = (props: QuickEPOption) => {
  const { id, value, index, style, query, resetTextBox } = props;
  const { uiStore } = useStore();
  const [showExtraSelector, setShowExtraSelector] = useState(false);
  const {
    style: popoverStyle,
    reference,
    floating,
    update,
  } = usePopover('bottom-start', ['right', 'left', 'bottom', 'top'], 'fixed');

  useLayoutEffect(() => {
    if (showExtraSelector) {
      update();
    }
  }, [showExtraSelector, update]);

  const handleBlur = useRef((e: React.FocusEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setShowExtraSelector(false);
    }
  }).current;

  const handleExtraPropertySelect = useCallback(
    (eventExtraProperty: ClientExtraProperty) => {
      resetTextBox();
      // Convert query to a valid value and set operator
      let value: any;
      let operator: OperatorType;
      switch (eventExtraProperty.type) {
        case ExtraPropertyType.text:
          value = query;
          operator = 'contains';
          break;
        case ExtraPropertyType.number:
          const match = query.match(/[-+]?\d*\.?\d+(e[-+]?\d+)?/i);
          value = match
            ? parseFloat(match[0])
            : getExtraPropertyDefaultValue(ExtraPropertyType.number);
          operator = 'equals';
          break;
        default:
          const _exhaustiveCheck: never = eventExtraProperty.type;
          return _exhaustiveCheck;
      }

      uiStore.addSearchCriteria(
        new ClientExtraPropertySearchCriteria(
          undefined,
          'extraProperties',
          [eventExtraProperty.id, value],
          operator,
        ),
      );
    },
    [query, resetTextBox, uiStore],
  );

  const portalRoot = document.getElementById(SEARCHBAR_ID);

  return (
    <>
      <Row
        style={style}
        id={id}
        index={index}
        value={value}
        onClick={() => {
          setShowExtraSelector(true);
        }}
      />
      {portalRoot &&
        // Need to use portals since popovers don't work inside containers that have the transform property, which is used in virtualized grid.
        ReactDOM.createPortal(
          <div ref={reference}>
            {showExtraSelector && (
              <div
                ref={floating}
                tabIndex={-1}
                onBlur={handleBlur}
                data-popover
                data-open={showExtraSelector}
                style={{ ...popoverStyle, zIndex: 1000 }}
              >
                <ExtraPropertySelector onSelect={handleExtraPropertySelect} />
              </div>
            )}
          </div>,
          portalRoot,
        )}
    </>
  );
};

const SearchDefaultTypeButton = observer(
  ({
    selectedKey,
    setSelectedKey,
  }: {
    selectedKey: Key;
    setSelectedKey: React.Dispatch<React.SetStateAction<Key>>;
  }) => {
    const { uiStore } = useStore();
    return (
      <MenuButton
        icon={<div className="text-icon">{FileKeyOptions[selectedKey]}</div>}
        text={FileKeyOptions[selectedKey]}
        id={'search-type-button'}
        menuID={'search-type-button-menu'}
        tooltip="Select property to search"
        placement="bottom-start"
        strategy="fixed"
      >
        {Object.entries(QuickSearchKeyOptions).map(([key, label]) => (
          <MenuItem key={key} text={label} onClick={() => setSelectedKey(key as Key)} />
        ))}
        <MenuItem
          text="Advanced search"
          key="advanced"
          onClick={uiStore.toggleAdvancedSearch}
          icon={IconSet.SEARCH_EXTENDED}
        />
      </MenuButton>
    );
  },
);

const SearchMatchButton = observer(({ disabled }: { disabled: boolean }) => {
  const { fileStore, uiStore } = useStore();

  const handleClick = useRef((e: React.MouseEvent) => {
    e.stopPropagation();
    uiStore.toggleSearchMatchAny();
    fileStore.refetch();
  }).current;

  return (
    <IconButton
      icon={uiStore.searchMatchAny ? IconSet.SEARCH_ANY : IconSet.SEARCH_ALL}
      text={`Search using ${uiStore.searchMatchAny ? 'any' : 'all'} queries`}
      onClick={handleClick}
      className="btn-icon-large"
      disabled={disabled}
    />
  );
});

const CriteriaList = observer(() => {
  const rootStore = useStore();
  const { fileStore, uiStore } = rootStore;
  return (
    <div className="input" onClick={uiStore.toggleAdvancedSearch}>
      <div className="multiautocomplete-input">
        <div className="input-wrapper">
          {uiStore.searchRootGroup.getLabels(CustomKeyDict, rootStore).map((label) => (
            <Tag
              key={`${label.id}`}
              text={label.label}
              onRemove={() => uiStore.removeSearchCriteriaById(label.id)}
              // Italicize system tags (for now only "Untagged images")
              className={label.isSystemTag ? 'italic' : undefined}
            />
          ))}
        </div>

        <IconButton
          icon={uiStore.searchMatchAny ? IconSet.SEARCH_ANY : IconSet.SEARCH_ALL}
          text={`Search using ${uiStore.searchMatchAny ? 'any' : 'all'} queries`}
          onClick={(e) => {
            uiStore.toggleSearchMatchAny();
            fileStore.refetch();
            e.stopPropagation();
            e.preventDefault();
            // TODO: search input element keeps focus after click???
          }}
          className="btn-icon-large"
        />

        <IconButton
          icon={IconSet.CLOSE}
          text="Clear"
          onClick={(e) => {
            uiStore.clearSearchCriteriaTree();
            e.stopPropagation();
            e.preventDefault();
          }}
        />
      </div>
    </div>
  );
});
