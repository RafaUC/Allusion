import { observer } from 'mobx-react-lite';
import React from 'react';
import { HexColorPicker } from 'react-colorful';

import { IconSet } from 'widgets';
import { Menu, MenuCheckboxItem, MenuDivider, MenuItem, MenuSubItem } from 'widgets/menus';
import { useStore } from '../../../contexts/StoreContext';
import { ClientTagSearchCriteria } from '../../../entities/SearchCriteria';
import { ClientTag } from '../../../entities/Tag';
import { Action, Factory } from './state';
import { hexCompare } from 'widgets/utility/color';

const defaultColorOptions = [
  { title: 'Eminence', color: '#5f3292' },
  { title: 'Indigo', color: '#5642A6' },
  { title: 'Blue Ribbon', color: '#143ef1' },
  { title: 'Azure Radiance', color: '#147df1' },
  { title: 'Aquamarine', color: '#6cdfe3' },
  { title: 'Aero Blue', color: '#bdfce4' },
  { title: 'Golden Fizz', color: '#f7ea3a' },
  { title: 'Goldenrod', color: '#fcd870' },
  { title: 'Christineapprox', color: '#f36a0f' },
  { title: 'Crimson', color: '#ec1335' },
  { title: 'Razzmatazz', color: '#ec125f' },
];

export const ColorPickerMenu = observer(({ tag }: { tag: ClientTag }) => {
  const { uiStore } = useStore();

  const handleChange = (color: string) => {
    if (tag.isSelected) {
      uiStore.colorSelectedTagsAndCollections(tag.id, color);
    } else {
      tag.setColor(color);
    }
  };
  const color = tag.color;

  return (
    <>
      {/* Rainbow gradient icon? */}
      <MenuCheckboxItem
        checked={color === 'inherit'}
        text="Inherit Parent Color"
        onClick={() => handleChange(color === 'inherit' ? '' : 'inherit')}
      />
      <MenuSubItem text="Pick Color" icon={IconSet.COLOR}>
        <div style={{ display: 'flex', flexWrap: 'wrap', width: 'min-content', gap: '3px' }}>
          <HexColorPicker color={color || undefined} onChange={handleChange} />
          <button
            key="none"
            aria-label="No Color"
            style={{
              background: 'none',
              border: '1px solid var(--text-color)',
              borderRadius: '100%',
              height: '1rem',
              width: '1rem',
            }}
            onClick={() => handleChange('')}
          />
          {defaultColorOptions.map(({ title, color }) => (
            <button
              key={title}
              aria-label={title}
              style={{
                background: color,
                border: 'none',
                borderRadius: '100%',
                height: '1rem',
                width: '1rem',
              }}
              onClick={() => handleChange(color)}
            />
          ))}
        </div>
      </MenuSubItem>
    </>
  );
});

export const TagVisibilityMenu = observer(({ tag }: { tag: ClientTag }) => {
  const { uiStore } = useStore();
  const handleVisibleInherit = (val: boolean) => {
    if (tag.isSelected) {
      uiStore.VisibleInheritSelectedTagsAndCollections(tag.id, val);
    } else {
      tag.setVisibleInherited(val);
    }
  };
  const isVisibleInherited = tag.isVisibleInherited;

  return (
    <>
      <MenuCheckboxItem
        checked={isVisibleInherited}
        text="Visible When Inherited"
        onClick={() => handleVisibleInherit(!isVisibleInherited)}
      />
    </>
  );
});

interface IContextMenuProps {
  tag: ClientTag;
  dispatch: React.Dispatch<Action>;
  pos: number;
}

export const TagItemContextMenu = observer((props: IContextMenuProps) => {
  const { tag, dispatch, pos } = props;
  const { tagStore, uiStore } = useStore();
  const ctxTags = uiStore.getTagContextItems(tag.id);

  return (
    <Menu>
      <MenuItem
        onClick={() =>
          tagStore
            .create(tag, 'New Tag')
            .then((t) => dispatch(Factory.insertNode(t, tag.id, t.id)))
            .catch((err) => console.log('Could not create tag', err))
        }
        text="New Tag"
        icon={IconSet.TAG_ADD}
      />
      <MenuItem
        onClick={() => uiStore.openTagPropertiesEditor(tag)}
        text="Edit Tag"
        icon={IconSet.EDIT}
      />
      <MenuItem
        onClick={() => dispatch(Factory.enableEditing(tag, tag.id))}
        text="Rename"
        icon={IconSet.EDIT}
      />
      <MenuItem
        icon={!tag.isHidden ? IconSet.HIDDEN : IconSet.PREVIEW}
        text="Hide Tagged Images"
        onClick={tag.toggleHidden}
      />
      <MenuItem
        onClick={() => uiStore.openTagMergePanel(tag)}
        text="Merge With"
        icon={IconSet.TAG_GROUP}
        disabled={ctxTags.some((tag) => tag.subTags.length > 0)}
      />
      <MenuItem
        onClick={() => dispatch(Factory.confirmDeletion(tag))}
        text="Delete"
        icon={IconSet.DELETE}
      />
      <MenuDivider />
      <TagVisibilityMenu tag={tag} />
      <ColorPickerMenu tag={tag} />
      <MenuDivider />
      <MenuItem
        onClick={() =>
          tag.isSelected
            ? uiStore.addTagSelectionToCriteria()
            : uiStore.addSearchCriteria(new ClientTagSearchCriteria(undefined, 'tags', tag.id))
        }
        text="Add to Search"
        icon={IconSet.SEARCH}
      />
      <MenuItem
        onClick={() =>
          tag.isSelected
            ? uiStore.replaceCriteriaWithTagSelection()
            : uiStore.replaceSearchCriteria(new ClientTagSearchCriteria(undefined, 'tags', tag.id))
        }
        text="Replace Search"
        icon={IconSet.REPLACE}
      />
      <MenuDivider />
      <MenuItem
        onClick={() => tag.parent.insertSubTag(tag, pos - 2)}
        text="Move Up"
        icon={IconSet.ITEM_MOVE_UP}
        disabled={pos === 1}
      />
      <MenuItem
        onClick={() => tag.parent.insertSubTag(tag, pos + 1)}
        text="Move Down"
        icon={IconSet.ITEM_MOVE_DOWN}
        disabled={pos === tag.parent.subTags.length}
      />
      <MenuItem
        onClick={() => uiStore.openTagMovePanel(tag)}
        text="Move To"
        icon={IconSet.TAG_GROUP}
      />
      <MenuSubItem
        text="Sort Selected..."
        icon={IconSet.FILTER_NAME_DOWN}
        disabled={ctxTags.length < 2}
      >
        <MenuItem
          onClick={() => uiStore.sortSelectedTagItems('ascending')}
          text="Sort by Name (Ascending)"
          icon={IconSet.FILTER_NAME_DOWN}
          disabled={ctxTags.length < 2}
        />
        <MenuItem
          onClick={() => uiStore.sortSelectedTagItems('descending')}
          text="Sort by Name (Descending)"
          icon={IconSet.FILTER_NAME_UP}
          disabled={ctxTags.length < 2}
        />
        <MenuItem
          onClick={() =>
            uiStore.sortSelectedTagItems('ascending', (a, b) => a.fileCount - b.fileCount)
          }
          text="Sort by File Count (Ascending)"
          icon={IconSet.FILTER_FILTER_DOWN}
          disabled={ctxTags.length < 2}
        />
        <MenuItem
          onClick={() =>
            uiStore.sortSelectedTagItems('descending', (a, b) => a.fileCount - b.fileCount)
          }
          text="Sort by File Count (Descending)"
          icon={IconSet.FILTER_FILTER_DOWN}
          disabled={ctxTags.length < 2}
        />
        <MenuItem
          onClick={() =>
            uiStore.sortSelectedTagItems('ascending', (a, b) =>
              hexCompare(a.viewColor, b.viewColor),
            )
          }
          text="Sort by Color (Ascending)"
          icon={IconSet.COLOR}
          disabled={ctxTags.length < 2}
        />
        <MenuItem
          onClick={() =>
            uiStore.sortSelectedTagItems('descending', (a, b) =>
              hexCompare(a.viewColor, b.viewColor),
            )
          }
          text="Sort by Color (Descending)"
          icon={IconSet.COLOR}
          disabled={ctxTags.length < 2}
        />
        <MenuItem
          onClick={() =>
            uiStore.sortSelectedTagItems(
              'ascending',
              (a, b) => a.dateAdded.getTime() - b.dateAdded.getTime(),
            )
          }
          text="Sort by Date Added (Ascending)"
          icon={IconSet.FILTER_DATE}
          disabled={ctxTags.length < 2}
        />
        <MenuItem
          onClick={() =>
            uiStore.sortSelectedTagItems(
              'descending',
              (a, b) => a.dateAdded.getTime() - b.dateAdded.getTime(),
            )
          }
          text="Sort by Date Added (Descending)"
          icon={IconSet.FILTER_DATE}
          disabled={ctxTags.length < 2}
        />
      </MenuSubItem>
      {/* TODO: Sort alphanumerically option. Maybe in modal for more options (e.g. all levels or just 1 level) and for previewing without immediately saving */}
    </Menu>
  );
});
