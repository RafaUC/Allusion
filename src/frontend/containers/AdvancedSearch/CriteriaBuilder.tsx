import React, { RefObject, memo, useMemo, useState } from 'react';

import { IconButton } from 'widgets/button';
import { IconSet } from 'widgets/icons';
import { InfoButton } from 'widgets/notifications';
import { IndexInput, KeySelector, OperatorSelector, ValueInput } from './Inputs';
import { appendCriteriaByIndexPath, CritIndexPath, defaultQuery, QueryDispatch } from './data';
import { useStore } from 'src/frontend/contexts/StoreContext';

export interface QueryBuilderProps {
  keySelector: RefObject<HTMLSelectElement>;
  dispatch: QueryDispatch;
}

const CriteriaBuilder = memo(function QueryBuilder({ keySelector, dispatch }: QueryBuilderProps) {
  const [path, setPath] = useState<CritIndexPath>([]);
  const [criteria, setCriteria] = useState(defaultQuery('tags'));
  const { extraPropertyStore } = useStore();
  const epID = 'extraProperty' in criteria ? criteria.extraProperty : undefined;
  const extraProperty = useMemo(
    () => (epID !== undefined ? extraPropertyStore.get(epID) : undefined),
    [epID, extraPropertyStore],
  );

  const add = () => {
    dispatch((query) => appendCriteriaByIndexPath(query, criteria, path));
    setCriteria(defaultQuery('tags'));
    keySelector.current?.focus();
  };

  return (
    <fieldset aria-labelledby="criteria-builder-label">
      <legend id="criteria-builder-label">
        Criteria Builder
        <InfoButton>
          A criteria is made of three components:
          <ul>
            <li>
              <b>nesting</b> (decides in which group the criteria will be added. If empty, it will
              be added to the root group),
            </li>
            <li>
              <b>key</b> (a property of the image file),
            </li>
            <li>
              <b>operator</b> (decides how the property value is compared) and
            </li>
            <li>
              the matching <b>value</b>.
            </li>
          </ul>
          Every image that matches the criteria is shown.
          <br />
          <br />
          You can edit the inputs for each component and add the criteria to the query by pressing
          the{' '}
          <span aria-label="add criteria" style={{ verticalAlign: 'middle' }}>
            {IconSet.ADD}
          </span>{' '}
          icon button next to the inputs.
        </InfoButton>
      </legend>
      <div id="criteria-builder">
        <label id="builder-space">Nesting</label>
        <label id="builder-key">Key</label>
        <label id="builder-operator">Operator</label>
        <label id="builder-value">Value</label>
        <span></span>

        <IndexInput
          labelledby="builder-index" //
          path={path.join('.')}
          setValue={setPath}
        />
        <KeySelector
          labelledby="builder-key"
          ref={keySelector}
          keyValue={criteria.key}
          dispatch={setCriteria}
          extraProperty={extraProperty}
        />
        <OperatorSelector
          labelledby="builder-operator"
          keyValue={criteria.key}
          value={criteria.operator}
          dispatch={setCriteria}
          extraProperty={extraProperty}
        />
        <ValueInput
          labelledby="builder-value"
          keyValue={criteria.key}
          value={criteria.value}
          dispatch={setCriteria}
          extraProperty={extraProperty}
          operator={criteria.operator}
        />
        <IconButton text="Add Criteria" icon={IconSet.ADD} onClick={add} />
      </div>
    </fieldset>
  );
});

export default CriteriaBuilder;
