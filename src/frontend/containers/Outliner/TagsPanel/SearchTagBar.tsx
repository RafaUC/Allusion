import React, { useState } from 'react';
import { TagSelector } from 'src/frontend/components/TagSelector';
import { IconButton } from 'widgets/button';
import { IconSet } from 'widgets/icons';
import { TagsTreeItemRevealer } from './TagsTree';

const SearchTagBar = () => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className={`search-tag-bar ${isExpanded ? 'expanded' : ''}`} data-tooltip={'Search a Tag'}>
      <TagSelector
        strat="fixed"
        placement="right-start"
        multiline={false}
        selection={[]}
        onDeselect={() => {}}
        onSelect={(tag) => {
          TagsTreeItemRevealer.instance.revealTag(tag);
        }}
        onClear={() => {
          setIsExpanded((prev) => !prev);
        }}
        extraIconButtons={
          <IconButton //
            className="btn-icon-search"
            icon={IconSet.SEARCH}
            text="Search a Tag"
            onClick={() => {
              setIsExpanded((prev) => !prev);
            }}
          />
        }
      />
    </div>
  );
};

export default SearchTagBar;
