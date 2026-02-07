import { observer } from 'mobx-react-lite';
import React, { useCallback, useRef, useState } from 'react';
import { useStore } from 'src/frontend/contexts/StoreContext';
import { useAutorun } from 'src/frontend/hooks/mobx';
import { Button, IconSet } from 'widgets';
import { Dialog } from 'widgets/popovers';
import CriteriaBuilder from './CriteriaBuilder';
import { queryFromCriteria, intoGroup, Query, getemptyQuery } from './data';
import { QueryEditor } from './QueryEditor';

export const AdvancedSearchDialog = observer(() => {
  const { uiStore, tagStore } = useStore();
  const [query, setQuery] = useState<Query>(getemptyQuery());
  const keySelector = useRef<HTMLSelectElement>(null);
  // Initialize form with current queries. When the form is closed, all inputs
  // are unmounted to save memory.
  useAutorun(() => {
    let newQuery: Query = getemptyQuery();
    if (uiStore.isAdvancedSearchOpen) {
      newQuery = queryFromCriteria(uiStore.searchRootGroup);
      requestAnimationFrame(() => requestAnimationFrame(() => keySelector.current?.focus()));
    }
    setQuery(newQuery);
  });

  const search = useCallback(() => {
    //uiStore.replaceSearchRootConjuction(rootConjunction);
    uiStore.replaceSearchCriterias(intoGroup(query, tagStore));
    uiStore.closeAdvancedSearch();
  }, [query, tagStore, uiStore]);

  const reset = useRef(() => setQuery(getemptyQuery())).current;

  return (
    <Dialog
      open={uiStore.isAdvancedSearchOpen}
      title="Advanced Search"
      icon={IconSet.SEARCH_EXTENDED}
      onCancel={uiStore.closeAdvancedSearch}
    >
      <form id="search-form" role="search" method="dialog" onSubmit={(e) => e.preventDefault()}>
        <CriteriaBuilder keySelector={keySelector} dispatch={setQuery} />

        <QueryEditor query={query} setQuery={setQuery} />

        <br />

        <fieldset className="dialog-actions">
          <Button styling="outlined" text="Reset" icon={IconSet.CLOSE} onClick={reset} />
          <Button
            styling="filled"
            text="Search"
            icon={IconSet.SEARCH}
            onClick={search}
            disabled={query.children.size === 0}
          />
        </fieldset>
      </form>
    </Dialog>
  );
});

export default AdvancedSearchDialog;
