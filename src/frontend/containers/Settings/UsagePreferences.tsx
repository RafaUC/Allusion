import { observer } from 'mobx-react-lite';
import React from 'react';
import { useStore } from '../../contexts/StoreContext';
import UiStore from 'src/frontend/stores/UiStore';
import { Toggle } from 'widgets/checkbox';
import { Slider } from 'widgets/slider';
import { InfoButton } from 'widgets/notifications';
import { StringArrayEditor } from 'src/frontend/components/StringArrayEditor';

const handleBlur = (
  e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement, Element>,
  setFn: (value: string) => void,
) => {
  const value = e.currentTarget.value.trim();
  if (value.length > 0) {
    setFn(value);
  }
};

const handleKeyDown = (
  e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  setFn: (value: string) => void,
) => {
  e.stopPropagation();
  const value = e.currentTarget.value.trim();
  if (!e.shiftKey && e.key === 'Enter' && value.length > 0) {
    setFn(value);
    //e.currentTarget.blur();
  } else if (e.key === 'Escape') {
    // cancel with escape
    e.preventDefault();
    e.currentTarget.value = e.currentTarget.defaultValue;
    e.currentTarget.blur();
  }
};

// moved the labes one item up to aling them visually in the ui
const pageSizeOptions = [
  { value: 0, label: '250' },
  { value: 250 },
  { value: 500, label: '1K' },
  { value: 1000 },
  { value: 1500, label: '2K' },
  { value: 2000 },
  { value: 2500, label: '3K' },
  { value: 3000 },
  { value: 3500, label: '4K' },
  { value: 4000 },
  { value: 4500, label: '5K' },
  { value: 5000 },
  { value: 5500, label: '6K' },
  { value: 6000 },
  { value: 6500, label: '7K' },
  { value: 7000 },
  { value: 7500, label: '8K' },
  { value: 8000 },
  { value: 8500, label: '9K' },
  { value: 9000 },
  { value: 9500, label: '10K' },
  { value: 10000 },
];

export const UsagePreferences = observer(() => {
  const { uiStore, fileStore } = useStore();
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (isNaN(val)) {
      return;
    }
    fileStore.setPaginationSize(val);
  };

  return (
    <>
      <h3>Tag Selectors</h3>
      <div className="vstack">
        <Toggle
          checked={uiStore.isClearTagSelectorsOnSelectEnabled}
          onChange={uiStore.toggleClearTagSelectorsOnSelect}
        >
          Clear Tag Search Text After Select
        </Toggle>
        <RecentTagsNumber />
        <Toggle
          checked={uiStore.isIncludeSubtagsOnMatchEnabled}
          onChange={uiStore.toggleIncludeSubtagsOnMatch}
        >
          Include Sub-tags In Tag Selector Suggestion Matches
        </Toggle>
        <br />
        <div style={{ display: 'flex' }}>
          <InfoButton>
            <p>
              When pasting data into the File Tag Editor, any tag name that matches a literal string
              or a regex pattern in this list will appear unchecked by default.
              <br /> <br />
              To edit an option, click it and enter the new name or pattern.
            </p>
          </InfoButton>
          &nbsp;&nbsp;
          <label className="dialog-label">Bulk Tag Names / RegEx to Auto Disable</label>
        </div>
        <StringArrayEditor
          items={uiStore.autoDisableBulkTagNames.slice()}
          onAddItem={uiStore.addAutoDisableBulkTagName}
          onEditItem={uiStore.setAutoDisableBulkTagName}
          onRemoveItem={uiStore.removeAutoDisableBulkTagName}
          handleBlur={handleBlur}
          handleKeyDown={handleKeyDown}
        />
        <br />
        <div style={{ display: 'flex' }}>
          <InfoButton>
            <p>
              When pasting data into the File Tag Editor, any character or substring that matches
              this list will be removed.
              <br /> <br />
              To edit an option, click it and enter the new value.
            </p>
          </InfoButton>
          &nbsp;&nbsp;
          <label className="dialog-label">Bulk Tag Characters to Auto Remove</label>
        </div>
        <StringArrayEditor
          items={uiStore.bulkAutoRemoveStrings.slice()}
          onAddItem={uiStore.addBulkAutoRemoveString}
          onEditItem={uiStore.setBulkAutoRemoveString}
          onRemoveItem={uiStore.removeBulkAutoRemoveString}
          handleBlur={handleBlur}
          handleKeyDown={handleKeyDown}
        />
        <br />
      </div>

      <h3>Gallery</h3>
      <div className="vstack">
        <div id="page-size-controllers-container">
          <Slider
            value={fileStore.paginationSize}
            label={
              <span>
                <b>Pagination Size:</b> Number of files initially loaded and when reaching the
                scroll edge.{' '}
                <span style={{ fontWeight: 'lighter' }}>
                  (This setting heavily impacts memory usage and performance)
                </span>
              </span>
            }
            onChange={fileStore.setPaginationSize}
            id="pagination-size-slider"
            options={pageSizeOptions}
            min={pageSizeOptions[0].value}
            max={pageSizeOptions[pageSizeOptions.length - 1].value}
            step={20}
            secondaryInput={
              <input
                type="number"
                className="input"
                value={fileStore.paginationSize}
                onChange={handleInputChange}
                step={20}
              />
            }
          />
        </div>
      </div>
    </>
  );
});

const RecentTagsNumber = observer(() => {
  const { uiStore } = useStore();

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = Number(event.target.value);
    uiStore.setRecentlyUsedTagsMaxLength(value);
    // update recentlyUsedTags size
    uiStore.addRecentlyUsedTag();
  };

  return (
    <label>
      Maximum Number of Recently Used Tags to Remember
      <select value={uiStore.recentlyUsedTagsMaxLength} onChange={handleChange}>
        {[...Array(UiStore.MAX_RECENTLY_USED_TAGS + 1)].map((_, i) => (
          <option key={i} value={i}>
            {i}
          </option>
        ))}
      </select>
    </label>
  );
});
