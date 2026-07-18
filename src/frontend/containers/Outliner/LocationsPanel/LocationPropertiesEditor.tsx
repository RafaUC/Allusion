import { observer } from 'mobx-react-lite';
import React, { useMemo } from 'react';

import { Button, IconSet, Tag } from 'widgets';
import { Dialog } from 'widgets/popovers';
import { TagSelector } from 'src/frontend/components/TagSelector';
import { Placement } from '@floating-ui/core';
import { InfoButton } from 'widgets/notifications';
import { ClientLocation, ClientSubLocation } from 'src/frontend/entities/Location';
import { computed } from 'mobx';
import { ClientTag } from 'src/frontend/entities/Tag';
import { useStore } from 'src/frontend/contexts/StoreContext';

const FALLBACK_PLACEMENTS: Placement[] = ['bottom'];

interface LocationPropertiesEditorProps {
  locationToEdit: ClientLocation | ClientSubLocation | undefined;
  onClose: () => void;
}

export const LocationPropertiesEditor = observer(
  ({ locationToEdit, onClose }: LocationPropertiesEditorProps) => {
    const { locationStore } = useStore();
    const isOpen = locationToEdit !== undefined;

    const relatedTags = useMemo(
      () =>
        computed(() => {
          // Read again here to avoid mobx alerts when using this computed
          const tag = locationToEdit ? locationStore.getLocationTag(locationToEdit) : undefined;
          if (tag === undefined) {
            return new Set<ClientTag>();
          }
          const impliedAncestors = tag.getImpliedAncestors();
          const impliedSubTags = tag.getImpliedSubTree();
          return new Set<ClientTag>([...impliedAncestors, ...impliedSubTags]);
        }),
      [locationStore, locationToEdit],
    );

    const tagSelection = Array.from(locationToEdit?.tags ?? []);

    return (
      <Dialog
        open={isOpen}
        title={
          isOpen ? (
            <>
              Edit properties of <Tag key={locationToEdit.id} text={locationToEdit.name} />
            </>
          ) : (
            ''
          )
        }
        icon={IconSet.FOLDER_OPEN}
        onCancel={onClose}
        describedby="imply-info"
        className="location-properties-dialog"
      >
        <div id="location-properties-dialog-content">
          {isOpen ? (
            <>
              <fieldset>
                <div style={{ display: 'flex' }}>
                  <legend id="location-tags-label" className="dialog-section-label">
                    Location tags
                  </legend>
                  <InfoButton>
                    <p>
                      All the files under this location will be included when searching for these
                      tags.
                      <br /> <br />
                      Note: You cannot add already inherited implied tags, in order to avoid
                      circular relationships and maintain a clearer structure. Those are
                      automatically filtered out from the suggestion lists; if you cannot find one,
                      it probably means this location already implies it.
                    </p>
                  </InfoButton>
                </div>
                <br />
                <label className="dialog-label" htmlFor="location-tags-label-picker">
                  Location tags
                </label>
                <TagSelector
                  fallbackPlacements={FALLBACK_PLACEMENTS}
                  disabled={false}
                  selection={tagSelection}
                  onSelect={locationToEdit.addTags}
                  onDeselect={locationToEdit.removeTags}
                  onClear={locationToEdit.clearTags}
                  multiline
                  filter={(t) => !relatedTags.get().has(t)}
                  clearInputOnSelect={false}
                />
                <br />
                <br />
                <br />
                <br />
                <br />
                <br />
              </fieldset>
            </>
          ) : (
            <></>
          )}
        </div>
        <div className="dialog-actions">
          <Button text="Close" styling="filled" onClick={onClose} />
        </div>
      </Dialog>
    );
  },
);
