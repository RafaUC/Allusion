import React, { memo, useMemo } from 'react';

import { ID } from 'src/api/id';
import { IconSet } from 'widgets/icons';
import { Callout, InfoButton } from 'widgets/notifications';
import { Radio, RadioGroup } from 'widgets/radio';
import {
  ConjuctionSelector,
  IndexInput,
  KeySelector,
  OperatorSelector,
  ValueInput,
} from './Inputs';
import { Criteria } from './data';
import { useStore } from 'src/frontend/contexts/StoreContext';
import { clamp } from 'common/core';
import { SearchConjunction } from 'src/api/data-storage-search';

export type Query = Map<string, Criteria>;
export type QueryDispatch = React.Dispatch<React.SetStateAction<Query>>;

export interface QueryEditorProps {
  query: Query;
  setQuery: QueryDispatch;
  submissionButtonText?: string;
}

export const QueryEditor = memo(function QueryEditor({
  query,
  setQuery,
  submissionButtonText = 'Search',
}: QueryEditorProps) {
  let lastconjuction: SearchConjunction = query.entries().next().value?.[1].conjunction ?? 'and';
  return (
    <fieldset aria-labelledby="query-editor-container-label">
      <legend id="query-editor-container-label">
        Query Editor
        <InfoButton>
          A query is a list of criterias.
          <br />
          <br />
          In the editor you can edit already added criterias by changing the inputs or delete one by
          pressing the{' '}
          <span aria-label="remove criteria" style={{ verticalAlign: 'middle' }}>
            {IconSet.DELETE}
          </span>{' '}
          icon button next to the inputs.
          <br />
          <br />
          <p>
            When the search runs, criteria are automatically{' '}
            <strong>grouped by consecutive conjunctions</strong>. In practice this means:
          </p>
          <ul>
            <li>
              <strong>Adjacent criteria using the same conjunction</strong> (either <code>AND</code>{' '}
              or <code>OR</code>) are grouped together.
            </li>
            <li>Each group is evaluated as a single expression using its shared conjunction.</li>
            <li>The final search combines those groups in order.</li>
          </ul>
          <p>
            In other words, the conjunction applies between consecutive items, and the system will
            internally create the correct logical structure based on how you arranged them.
          </p>
        </InfoButton>
      </legend>
      {query.size === 0 ? (
        <Callout icon={IconSet.INFO} header="Empty Query">
          Your query is currently empty. Create a criteria above to enable the{' '}
          <b>{submissionButtonText}</b> button.
        </Callout>
      ) : undefined}
      <div id="query-editor-container">
        <div id="query-editor">
          {/*
          <div></div>
          <div id="col-key">Key</div>
          <div id="col-operator">Operator</div>
          <div id="col-value">Value</div>
          <div id="col-remove">Remove</div>
          */}
          {Array.from(query.entries(), ([id, criteria], index) => {
            const changed = lastconjuction !== criteria.conjunction;
            lastconjuction = criteria.conjunction;
            return (
              <React.Fragment key={id}>
                {changed && <CriteriaSeparator text={'AND'} />}
                <EditableCriteria
                  index={index}
                  id={id}
                  criteria={criteria}
                  dispatch={setQuery}
                  totalCriterias={query.size}
                />
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </fieldset>
  );
});

const CriteriaSeparator = ({ text }: { text: string }) => {
  return <div className="separator">{text}</div>;
};

function reorderMapByIndex<K, V>(map: Map<K, V>, fromIndex: number, toIndex: number): Map<K, V> {
  const entries = Array.from(map.entries());
  const [moved] = entries.splice(fromIndex, 1);
  entries.splice(toIndex, 0, moved);
  return new Map(entries);
}

export interface EditableCriteriaProps {
  index: number;
  id: ID;
  criteria: Criteria;
  dispatch: QueryDispatch;
  totalCriterias: number;
}

// The main Criteria component, finds whatever input fields for the key should be rendered
export const EditableCriteria = (props: EditableCriteriaProps) => {
  const { index, id, criteria, dispatch, totalCriterias } = props;
  const setCriteria = (fn: (criteria: Criteria) => Criteria) => {
    const c = fn(criteria);
    dispatch((query) => new Map(query.set(id, c)));
  };
  const setIndex = (newIndex: number) => {
    newIndex = clamp(newIndex - 1, 0, totalCriterias - 1);
    dispatch((query) => reorderMapByIndex(query, index, newIndex));
  };
  const { extraPropertyStore } = useStore();
  const epID = 'extraProperty' in criteria ? criteria.extraProperty : undefined;
  const extraProperty = useMemo(
    () => (epID !== undefined ? extraPropertyStore.get(epID) : undefined),
    [epID, extraPropertyStore],
  );

  return (
    <div style={{ display: 'contents' }}>
      <IndexInput
        labelledby={`${id} col-index`}
        value={index + 1}
        setValue={setIndex}
        total={totalCriterias}
      />
      <ConjuctionSelector
        labelledby={`${id} col-conjuction`}
        value={criteria.conjunction}
        dispatch={setCriteria}
      />
      <KeySelector
        labelledby={`${id} col-key`}
        keyValue={criteria.key}
        dispatch={setCriteria}
        extraProperty={extraProperty}
      />
      <OperatorSelector
        labelledby={`${id} col-operator`}
        keyValue={criteria.key}
        value={criteria.operator}
        dispatch={setCriteria}
        extraProperty={extraProperty}
      />
      <ValueInput
        labelledby={`${id} col-value`}
        keyValue={criteria.key}
        value={criteria.value}
        dispatch={setCriteria}
        extraProperty={extraProperty}
        operator={criteria.operator}
      />
      <button
        className="btn-icon"
        data-tooltip={`Remove Criteria ${index + 1}`}
        aria-labelledby={`col-remove ${id}`}
        type="button"
        onClick={() =>
          dispatch((form) => {
            form.delete(id);
            return new Map(form);
          })
        }
      >
        {IconSet.DELETE}
        <span className="visually-hidden">Remove Criteria</span>
      </button>
    </div>
  );
};

type QueryMatchProps = {
  searchMatchAny: boolean;
  toggle: () => void;
};

export const QueryMatch: React.FC<QueryMatchProps> = ({ searchMatchAny, toggle }) => {
  return (
    <RadioGroup
      name="Match"
      orientation="horizontal"
      value={String(searchMatchAny)}
      onChange={toggle}
    >
      <Radio value="true">Any</Radio>
      <Radio value="false">All</Radio>
    </RadioGroup>
  );
};
