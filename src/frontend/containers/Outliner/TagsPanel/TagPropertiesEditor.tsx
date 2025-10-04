import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button, IconSet, Tag } from 'widgets';
import { Dialog } from 'widgets/popovers';
import { ClientTag } from '../../../entities/Tag';
import { TagSelector } from 'src/frontend/components/TagSelector';
import { Placement } from '@floating-ui/core';
import { computed } from 'mobx';
import { InfoButton } from 'widgets/notifications';
import { ColorPickerMenu, TagVisibilityMenu } from './ContextMenu';
import { Menu, MenuCheckboxItem } from 'widgets/menus';
import { useStore } from 'src/frontend/contexts/StoreContext';

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

const FALLBACK_PLACEMENTS: Placement[] = ['bottom'];

export const TagPropertiesEditor = observer(() => {
  const { uiStore } = useStore();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const tag = uiStore.tagToEdit;
  const isOpen = tag !== undefined;

  // updates the number of rows of the event currentTarget
  const textAreaAutoSize = useRef((event: React.FormEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget;
    textarea.rows = 1; // Reset rows to measure properly
    const lineHeightStr = getComputedStyle(textarea).lineHeight;
    const lineHeight = parseFloat(lineHeightStr);
    if (lineHeight && !isNaN(lineHeight)) {
      const currentRows = Math.floor(textarea.scrollHeight / lineHeight);
      textarea.rows = Math.min(currentRows, 15);
    }
  }).current;

  // initialize description textArea size
  useEffect(() => {
    if (descriptionRef.current) {
      textAreaAutoSize({
        currentTarget: descriptionRef.current,
      } as React.FormEvent<HTMLTextAreaElement>);
    }
  }, [tag, textAreaAutoSize]);

  const relatedTags = useMemo(
    () =>
      computed(() => {
        // Read again here to avoid mobx alerts when using this computed
        const tag = uiStore.tagToEdit;
        if (tag === undefined) {
          return new Set<ClientTag>();
        }
        const impliedAncestors = tag.getImpliedAncestors();
        const impliedSubTags = tag.getImpliedSubTree();
        return new Set<ClientTag>([...impliedAncestors, ...impliedSubTags]);
      }),
    [uiStore.tagToEdit],
  );

  return (
    <Dialog
      open={isOpen}
      title={
        isOpen ? (
          <>
            Edit properties of{' '}
            <Tag key={tag.id} text={tag.name} color={tag.viewColor} isHeader={tag.isHeader} />
          </>
        ) : (
          ''
        )
      }
      icon={IconSet.TAG_GROUP}
      onCancel={uiStore.closeTagPropertiesEditor}
      describedby="imply-info"
      className="tag-properties-dialog"
    >
      <div id="tag-properties-dialog-content">
        {isOpen ? (
          <>
            <fieldset>
              <legend id="tag-name-label" className="dialog-section-label">
                Tag Name
              </legend>
              <input
                ref={nameInputRef}
                className="input"
                autoFocus
                type="text"
                defaultValue={tag.name}
                onBlur={(e) => handleBlur(e, tag.rename)}
                onKeyDown={(e) => handleKeyDown(e, tag.rename)}
              />
              <br />
              <br />
              <div style={{ display: 'flex' }}>
                <label className="dialog-label">Aliases</label>
                <InfoButton>
                  <p>
                    Aliases let you find a tag using alternative names. <br /> <br />
                    To edit an alias, click it and enter the new name.
                  </p>
                </InfoButton>
              </div>
              <AliasEditor tag={tag} />
              <br />
              <div style={{ display: 'flex' }}>
                <label className="dialog-label">Description</label>
                <InfoButton>
                  <p>
                    Tag descriptions will appear if you hover over the magnifying glass icon in the
                    tags tree panel or hover over a tag option name in tag selectors.
                  </p>
                </InfoButton>
              </div>
              <textarea
                ref={descriptionRef}
                className="input"
                defaultValue={tag.description}
                onInput={textAreaAutoSize}
                onKeyDown={(e) => handleKeyDown(e, tag.setDescription)}
                onBlur={(e) => handleBlur(e, tag.setDescription)}
              />
            </fieldset>

            <br />

            <fieldset>
              <legend id="tag-name-label" className="dialog-section-label">
                Appearance
              </legend>
              <Menu>
                <MenuCheckboxItem
                  checked={tag.isHeader}
                  text="Show as Header"
                  onClick={tag.toggleHeader}
                />
                <ColorPickerMenu tag={tag} />
                <TagVisibilityMenu tag={tag} />
              </Menu>
            </fieldset>

            <br />

            <fieldset>
              <div style={{ display: 'flex' }}>
                <legend id="tags-imply-label" className="dialog-section-label">
                  Implied Tags
                </legend>
                <InfoButton>
                  <p>
                    Implied tags are tags that are automatically added or inherited when this tag is
                    used. <br /> <br />
                    Note: You cannot imply a parent, child, inherited implied, or implied-by tag, in
                    order to avoid circular relationships and maintain a clearer structure.
                  </p>
                </InfoButton>
              </div>
              <label className="dialog-label" htmlFor="tag-imply-picker">
                Tags implied by this tag
              </label>
              <br />
              <TagSelector
                fallbackPlacements={FALLBACK_PLACEMENTS}
                disabled={false}
                selection={tag.impliedTags}
                onSelect={tag.addImpliedTag}
                onDeselect={tag.removeImpliedTag}
                onClear={() => tag.replaceImpliedTags([])}
                multiline
                filter={(t) => !relatedTags.get().has(t)}
              />
              <br />
              <label className="dialog-label" htmlFor="tag-implyBy-picker">
                Tags that imply this tag
              </label>
              <TagSelector
                fallbackPlacements={FALLBACK_PLACEMENTS}
                disabled={false}
                selection={tag.impliedByTags}
                onSelect={tag.addImpliedByTag}
                onDeselect={tag.removeImpliedByTag}
                onClear={() => tag.replaceImpliedByTags([])}
                multiline
                filter={(t) => !relatedTags.get().has(t)}
              />
            </fieldset>
          </>
        ) : (
          <></>
        )}
      </div>
      <div className="dialog-actions">
        <Button text="Close" styling="filled" onClick={uiStore.closeTagPropertiesEditor} />
      </div>
    </Dialog>
  );
});

interface AliasEditorProps {
  tag: ClientTag;
}

const AliasEditor = observer(({ tag }: AliasEditorProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editIndex, setEditIndex] = useState<number | undefined>(undefined);

  const setAlias = useCallback(
    (value: string) => {
      if (editIndex !== undefined) {
        tag.setAlias(value, editIndex);
      } else {
        tag.addAlias(value);
        const input = inputRef.current;
        if (input) {
          input.value = input.defaultValue;
        }
      }
      setEditIndex(undefined);
    },
    [editIndex, tag],
  );

  useEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.value = input.defaultValue;
      if (input.defaultValue) {
        input.focus();
      }
    }
  }, [editIndex]);

  return (
    <div role="combobox" className="input multiautocomplete multiline multiautocomplete-input">
      <div className="input-wrapper">
        {tag.aliases.map((alias, index) => (
          <Tag
            key={index}
            text={alias}
            color={tag.viewColor}
            isHeader={tag.isHeader}
            onClick={() => setEditIndex(index)}
            onRemove={() => tag.removeAlias(index)}
          />
        ))}
        <input
          ref={inputRef}
          type="text"
          defaultValue={editIndex !== undefined ? tag.aliases[editIndex] : ''}
          onBlur={(e) => handleBlur(e, setAlias)}
          onKeyDown={(e) => handleKeyDown(e, setAlias)}
        />
      </div>
    </div>
  );
});
