import React, { memo, useCallback, useMemo } from 'react';

import { ID } from 'src/api/id';
import { IconSet } from 'widgets/icons';
import { Callout, InfoButton } from 'widgets/notifications';
import { Radio, RadioGroup } from 'widgets/radio';
import {
  ConjuctionSelector,
  ConjuctionSelectorProps,
  IndexInput,
  KeySelector,
  OperatorSelector,
  ValueInput,
} from './Inputs';
import {
  Criteria,
  CriteriaGroup,
  CritIndexPath,
  deleteNode,
  getPathByIndexPath,
  isCriteriaGroup,
  moveNodeByIndexPath,
  parseIndexPath,
  Query,
  QueryDispatch,
  updateNode,
} from './data';
import { useStore } from 'src/frontend/contexts/StoreContext';
import { SearchConjunction } from 'src/api/data-storage-search';

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
          To change the order of criteria and groups, or move them to different groups, modify their
          nesting position using the index/nesting input at the start of each criterion row.
          <br />
          <br />
          To change how criteria are evaluated together, change the conjunction (AND/OR) between
          groups/criteria.
          <br />
          <br />
          You can set a name for groups for better identification. If defined, it will replace the
          labels in the search bar and saved searches hierarchy.
          <br />
          <br />
        </InfoButton>
      </legend>
      {query.children.size === 0 ? (
        <Callout icon={IconSet.INFO} header="Empty Query">
          Your query is currently empty. Create a criteria above to enable the{' '}
          <b>{submissionButtonText}</b> button.
        </Callout>
      ) : undefined}
      <div id="query-editor-container">
        <EditableCriteriaGroup
          group={query} //
          groupId={''}
          path={''}
          setQuery={setQuery}
        />
      </div>
    </fieldset>
  );
});

export const GroupConjunctionEditor = (props: ConjuctionSelectorProps & { className?: string }) => {
  const { labelledby, value, setConjunction, className } = props;
  return (
    <div className={`separator ${className}`}>
      <ConjuctionSelector labelledby={labelledby} value={value} setConjunction={setConjunction} />
    </div>
  );
};

export const CriteriaSeparator = ({ text, className }: { text: string; className?: string }) => {
  return <div className={`separator ${className}`}>{text}</div>;
};

export const EditableGroupControls = (props: EditableCriteriaGroupProps) => {
  const { groupId, group, path, setQuery } = props;
  const handleChangeGroupIndex = useCallback(
    (toIndexPat: CritIndexPath) => {
      const groupIndexPat = parseIndexPath(path);
      setQuery((query) => moveNodeByIndexPath(query, groupIndexPat, toIndexPat));
    },
    [path, setQuery],
  );
  const handelDelete = useCallback(() => {
    setQuery((query) => {
      const critPath = getPathByIndexPath(query, parseIndexPath(path));
      if (!critPath) {
        return query;
      }
      return deleteNode(query, critPath);
    });
  }, [path, setQuery]);
  const handelChangeName = useCallback(
    (newName: string) => {
      setQuery((query) => {
        const critPath = getPathByIndexPath(query, parseIndexPath(path));
        if (!critPath) {
          return query;
        }
        return updateNode(query, critPath, (node) => (node ? { ...node, name: newName } : null));
      });
    },
    [path, setQuery],
  );
  return (
    <div className="group-controls">
      <IndexInput
        labelledby={`${groupId} group-index`} //
        path={path}
        setValue={handleChangeGroupIndex}
      />
      <input
        aria-labelledby={`${groupId} group-name`}
        className="input criteria-input group-name-input"
        type="text"
        placeholder="Criteria Group Name"
        defaultValue={group.name}
        onBlur={(e) => handelChangeName(e.target.value)}
      />
      <button
        className="btn-icon"
        data-tooltip={`Remove Group ${path}`}
        title={`Remove Group ${path}`}
        aria-labelledby={`col-group-remove ${groupId}`}
        type="button"
        onClick={handelDelete}
      >
        {IconSet.DELETE}
        <span className="visually-hidden">Remove Criteria</span>
      </button>
    </div>
  );
};

export interface EditableCriteriaGroupProps {
  groupId: string;
  group: CriteriaGroup;
  path: string;
  setQuery: QueryDispatch;
}

export const EditableCriteriaGroup = React.memo(function EditableCriteriaGroup(
  props: EditableCriteriaGroupProps,
) {
  const { group, groupId, path, setQuery } = props;
  const handleChangeConjunction = useCallback(
    (conjunction: SearchConjunction) => {
      setQuery((query) => {
        const critPath = getPathByIndexPath(query, parseIndexPath(path));
        if (!critPath) {
          return query;
        }
        return updateNode(query, critPath, (node) => (node ? { ...node, conjunction } : null));
      });
    },
    [path, setQuery],
  );
  return (
    <div className="group-containter query-editor">
      {path !== '' && (
        <EditableGroupControls groupId={groupId} group={group} path={path} setQuery={setQuery} />
      )}
      {Array.from(group.children.entries(), ([nodeCompId, node], nodeIndex) => (
        <React.Fragment key={nodeCompId}>
          {nodeIndex > 0 && (
            <GroupConjunctionEditor
              labelledby={`${groupId} group-conjunction`}
              value={group.conjunction}
              setConjunction={handleChangeConjunction}
              className="criteria-separator"
            />
          )}
          {/*critIndex > 1 && (
            <CriteriaSeparator
              text={SearchConjuctionSymbols[group.conjunction]}
              className="criteria-separator"
            />
          )*/}
          {isCriteriaGroup(node) ? (
            <EditableCriteriaGroup
              group={node}
              groupId={nodeCompId}
              path={`${path ? `${path}.` : ''}${nodeIndex}`}
              setQuery={setQuery}
            />
          ) : (
            <EditableCriteria
              critId={nodeCompId}
              criteria={node}
              path={`${path ? `${path}.` : ''}${nodeIndex}`}
              dispatch={setQuery}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
});

export interface EditableCriteriaProps {
  critId: ID;
  criteria: Criteria;
  path: string;
  dispatch: QueryDispatch;
}

// The main Criteria component, finds whatever input fields for the key should be rendered
export const EditableCriteria = React.memo(function EditableCriteria(props: EditableCriteriaProps) {
  const { critId, criteria, path, dispatch } = props;
  const setCriteria = (fn: (criteria: Criteria) => Criteria) => {
    dispatch((query) => {
      const critPath = getPathByIndexPath(query, parseIndexPath(path));
      if (!critPath) {
        return query;
      }
      return updateNode(query, critPath, (node) =>
        node ? (!isCriteriaGroup(node) ? { ...node, ...fn(node) } : { ...node }) : null,
      );
    });
  };
  const setIndex = (toIndexPat: CritIndexPath) => {
    const critIndexPat = parseIndexPath(path);
    dispatch((query) => moveNodeByIndexPath(query, critIndexPat, toIndexPat));
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
        labelledby={`${critId} col-index`} //
        path={path}
        setValue={setIndex}
      />
      <KeySelector
        labelledby={`${critId} col-key`}
        keyValue={criteria.key}
        dispatch={setCriteria}
        extraProperty={extraProperty}
      />
      <OperatorSelector
        labelledby={`${critId} col-operator`}
        keyValue={criteria.key}
        value={criteria.operator}
        dispatch={setCriteria}
        extraProperty={extraProperty}
      />
      <ValueInput
        labelledby={`${critId} col-value`}
        keyValue={criteria.key}
        value={criteria.value}
        dispatch={setCriteria}
        extraProperty={extraProperty}
        operator={criteria.operator}
      />
      <button
        className="btn-icon"
        data-tooltip={`Remove Criteria ${path}`}
        title={`Remove Criteria ${path}`}
        aria-labelledby={`col-remove ${critId}`}
        type="button"
        onClick={() =>
          dispatch((query) => {
            const critPath = getPathByIndexPath(query, parseIndexPath(path));
            if (!critPath) {
              return query;
            }
            return deleteNode(query, critPath);
          })
        }
      >
        {IconSet.DELETE}
        <span className="visually-hidden">Remove Criteria</span>
      </button>
    </div>
  );
});

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
