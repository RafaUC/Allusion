import React, { useId } from 'react';
import { IconSet } from 'widgets/icons';
import {
  MenuButton,
  MenuCheckboxItem,
  MenuDivider,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSubItem,
} from 'widgets/menus';
import { useStore } from '../contexts/StoreContext';
import { observer } from 'mobx-react-lite';

const TagSelectorSettingsButton = observer(() => {
  const { uiStore, tagPaletteStore } = useStore();
  const id = useId();
  return (
    <MenuButton
      icon={IconSet.SETTINGS}
      text=""
      id={id}
      menuID={`${id}-menu`}
      tooltip="Tag Selector Settings"
      placement="bottom-start"
      strategy="fixed"
    >
      <MenuSubItem text="Tag List Source" icon={IconSet.TAG_GROUP}>
        <MenuRadioGroup>
          <MenuRadioItem
            icon={IconSet.VIEW_LIST}
            text="All Tags"
            checked={tagPaletteStore.activePallete === undefined}
            onClick={() => tagPaletteStore.setActivePallete(undefined)}
          />
          <MenuDivider label="Tag Palettes" />
          <div className="tag-palette-list config-scrollbar">
            {tagPaletteStore.paletteList.length > 0 ? (
              <>
                {tagPaletteStore.paletteList.map((palette) => (
                  <MenuRadioItem
                    key={palette.id}
                    icon={IconSet.TREE_LIST}
                    text={palette.name}
                    checked={tagPaletteStore.activePallete?.id === palette.id}
                    onClick={() => tagPaletteStore.setActivePallete(palette)}
                  />
                ))}
              </>
            ) : (
              <MenuItem
                icon={IconSet.TAG_GROUP_OPEN}
                text="Add New Tag Palette"
                onClick={async () => {
                  const newPalette = await tagPaletteStore.createPalette('New Tag Palette 1');
                  tagPaletteStore.setActivePallete(newPalette);
                  uiStore.openTagPaletteEditor();
                }}
              />
            )}
          </div>
        </MenuRadioGroup>
      </MenuSubItem>
      <MenuItem
        icon={IconSet.TAG_GROUP_OPEN}
        text="Manage Tag Palettes"
        onClick={uiStore.toggleTagPaletteEditor}
      />
      <MenuCheckboxItem
        text="Clear Tag Search Text After Select"
        //accelerator={IconSet.SETTINGS}
        checked={uiStore.isClearTagSelectorsOnSelectEnabled}
        onClick={uiStore.toggleClearTagSelectorsOnSelect}
      />
      <MenuCheckboxItem
        text="Include Sub-tags In Suggestion Matches"
        //accelerator={IconSet.SETTINGS}
        checked={uiStore.isIncludeSubtagsOnMatchEnabled}
        onClick={uiStore.toggleIncludeSubtagsOnMatch}
      />
    </MenuButton>
  );
});

export default TagSelectorSettingsButton;
