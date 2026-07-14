import { observer } from 'mobx-react-lite';
import React, { useRef, useState } from 'react';

import { Button, IconSet } from 'widgets';
import { Dialog } from 'widgets/popovers';
import { useStore } from 'src/frontend/contexts/StoreContext';
import { TagSelector } from 'src/frontend/components/TagSelector';
import { Placement } from '@floating-ui/core';
import { TagOrderEditor } from 'src/frontend/components/TagOrderEditor';
import { runInAction } from 'mobx';
import { ClientTagPalette } from 'src/frontend/entities/TagPalette';

const FALLBACK_PLACEMENTS: Placement[] = ['top'];

export const TagPaletteEditor = observer(() => {
  const { uiStore, tagPaletteStore } = useStore();
  const isOpen = uiStore.isTagPaletteEditorOpen;
  const [selectedPaletteId, setSelectedPaletteId] = useState<string | undefined>(undefined);
  const [draggedPaletteId, setDraggedPaletteId] = useState<string | null>(null);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const tagSelectorRef = useRef<HTMLInputElement>(null);

  // Fallback to the first palette if the current selection becomes invalid or is empty
  const activePalette =
    tagPaletteStore.get(selectedPaletteId ?? '') ?? tagPaletteStore.paletteList.at(0);

  const handleCreatePalette = async () => {
    runInAction(async () => {
      const baseName = 'New Tag Palette';
      const existingPalettes = tagPaletteStore.paletteList.filter((p) =>
        p.name.startsWith(baseName),
      );
      const targetName =
        existingPalettes.length === 0 ? baseName : `${baseName} ${existingPalettes.length}`;
      const newPalette = await tagPaletteStore.createPalette(targetName);
      setSelectedPaletteId(newPalette.id);
    });
  };

  const handleDeletePalette = (paletteToDelete: ClientTagPalette) =>
    runInAction(async () => {
      const list = tagPaletteStore.paletteList;
      const currentIndex = list.findIndex((p) => p.id === paletteToDelete.id);
      let nextPaletteId: string | undefined = undefined;

      if (list.length > 1) {
        const nextIndex = currentIndex === list.length - 1 ? currentIndex - 1 : currentIndex;
        const remainingPalettes = list.filter((p) => p.id !== paletteToDelete.id);
        nextPaletteId = remainingPalettes[nextIndex]?.id;
      }

      if (activePalette?.id === paletteToDelete.id) {
        setSelectedPaletteId(nextPaletteId);
      }

      await tagPaletteStore.deletePalette(paletteToDelete);
    });

  ////////////// Drag ///////////

  const handleDragStart = (id: string) => {
    setDraggedPaletteId(id);
  };

  const handleDragOver = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (draggedPaletteId === null) {
      return;
    }
    const sourcePalette = tagPaletteStore.get(draggedPaletteId);
    if (!sourcePalette) {
      return;
    }
    const currentIndex = tagPaletteStore.findIndex(draggedPaletteId);
    if (currentIndex !== -1 && currentIndex !== targetIndex) {
      tagPaletteStore.reorderPalette(sourcePalette, targetIndex);
    }
  };

  ///////////

  return (
    <Dialog
      open={isOpen}
      title="Manage Tag Palettes"
      icon={IconSet.TAG_GROUP}
      onCancel={uiStore.closeTagPaletteEditor}
      className="tag-palette-dialog"
    >
      <div id="tag-palette-dialog-content">
        {isOpen && (
          <>
            <div className="palette-sidebar">
              <div className="sidebar-header">
                <span>Palettes</span>
                <button
                  type="button"
                  className="button is-compact"
                  onClick={handleCreatePalette}
                  title="Create new palette"
                >
                  {IconSet.ADD} Add
                </button>
              </div>

              <div className="palette-vertical-list config-scrollbar">
                {tagPaletteStore.isEmpty ? (
                  <div className="empty-state">No palettes available</div>
                ) : (
                  tagPaletteStore.paletteList.map((palette, index) => {
                    const isSelected = activePalette?.id === palette.id;
                    const isDragging = draggedPaletteId === palette.id;

                    return (
                      <div
                        key={palette.id}
                        draggable
                        onDragStart={() => handleDragStart(palette.id)}
                        onDragOver={(e) => handleDragOver(e, index)}
                        onDragEnd={() => setDraggedPaletteId(null)}
                        onClick={() => setSelectedPaletteId(palette.id)}
                        className={`palette-list-item ${isSelected ? 'is-selected' : ''} ${
                          isDragging ? 'is-dragging' : ''
                        }`}
                      >
                        <span className="palette-name">{palette.name}</span>

                        <button
                          type="button"
                          className="delete-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeletePalette(palette);
                          }}
                          title="Delete palette"
                        >
                          {IconSet.DELETE}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="palette-main-editor" style={{ flex: 1 }}>
              {activePalette ? (
                <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
                  <legend
                    className="dialog-section-label"
                    style={{ marginBottom: '15px', fontWeight: 'bold' }}
                  >
                    Tag Palette Properties
                  </legend>

                  <label className="dialog-label">Palette Name</label>
                  <input
                    key={activePalette.id}
                    ref={nameInputRef}
                    className="input"
                    autoFocus
                    type="text"
                    defaultValue={activePalette.name}
                    onBlur={(e) => handleBlur(e, activePalette.rename)}
                    onKeyDown={(e) => handleKeyDown(e, activePalette.rename)}
                  />
                  <br />
                  <br />

                  <label className="dialog-label">
                    Search and append tags{' '}
                    <span style={{ fontSize: '11px', opacity: 0.6 }}>
                      (Click to select, drag to reorder)
                    </span>
                  </label>
                  <br />
                  <TagSelector
                    ref={tagSelectorRef}
                    fallbackPlacements={FALLBACK_PLACEMENTS}
                    placement="top"
                    disabled={false}
                    selection={[]}
                    onSelect={(tag) => {
                      activePalette.addTag(tag);
                    }}
                    onDeselect={(tag) => activePalette.tags.remove(tag)}
                    onClear={activePalette.clearTags}
                    multiline
                  />
                  <br />
                  <TagOrderEditor
                    multiline
                    selection={activePalette.tags}
                    onMoveSelection={(selectedIndices, targetIndex) => {
                      activePalette.moveTagsSelectionByIndices(selectedIndices, targetIndex);
                    }}
                    onRemoveTag={(_tag, index) => activePalette.removeTagAt(index)}
                    onBackgroundClick={() => tagSelectorRef.current?.focus()}
                  />
                </fieldset>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    opacity: 0.5,
                  }}
                >
                  Select or create a palette from the sidebar to start editing.
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <div className="dialog-actions">
        <Button text="Close" styling="filled" onClick={uiStore.closeTagPaletteEditor} />
      </div>
    </Dialog>
  );
});

export default TagPaletteEditor;

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
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.currentTarget.value = e.currentTarget.defaultValue;
    e.currentTarget.blur();
  }
};
