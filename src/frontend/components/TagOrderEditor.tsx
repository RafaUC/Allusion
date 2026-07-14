import { observer } from 'mobx-react-lite';
import React, { useState, useCallback } from 'react';
import { Tag } from 'widgets';
import { ClientTag } from '../entities/Tag';

export interface TagOrderEditorProps {
  selection: ClientTag[];
  /** Exposes a Set of position indices and the target layout insertion index */
  onMoveSelection: (selectedIndices: Set<number>, targetIndex: number) => void;
  onRemoveTag?: (tag: ClientTag, index: number) => void;
  onBackgroundClick?: () => void;
  multiline?: boolean;
}

export const TagOrderEditor = observer((props: TagOrderEditorProps) => {
  const {
    selection: _selection,
    onMoveSelection,
    onRemoveTag,
    onBackgroundClick,
    multiline,
  } = props;
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const selection = _selection.slice();
  // Handles selection including Shift, Ctrl, and Cmd key modifiers
  const handleTagClick = useCallback(
    (index: number, e: React.MouseEvent) => {
      e.stopPropagation();

      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;

      setSelectedIndices((prev) => {
        const next = new Set(prev);

        // Range multi-selection using Shift modifier
        if (isShift && lastSelectedIndex !== null) {
          const start = Math.min(lastSelectedIndex, index);
          const end = Math.max(lastSelectedIndex, index);

          if (!isCmdOrCtrl) {
            next.clear();
          }

          for (let i = start; i <= end; i++) {
            next.add(i);
          }
        }
        // Granular toggle using Ctrl or Cmd modifier
        else if (isCmdOrCtrl) {
          if (next.has(index)) {
            next.delete(index);
          } else {
            next.add(index);
          }
        }
        // Default click behavior (Resets selection pool to the targeted element exclusively)
        else {
          next.clear();
          next.add(index);
        }

        return next;
      });
      setLastSelectedIndex(index);
    },
    [lastSelectedIndex],
  );

  const handleDragStart = useCallback(
    (index: number, e: React.DragEvent) => {
      if (!selectedIndices.has(index)) {
        setSelectedIndices(new Set([index]));
        setLastSelectedIndex(index);
      }

      setDraggedIndex(index);
      e.dataTransfer.setData('text/plain', String(index));
      e.dataTransfer.effectAllowed = 'move';
    },
    [selectedIndices],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
  }, []);

  const handleDrop = useCallback(
    (targetIndex: number, e: React.DragEvent) => {
      e.preventDefault();
      if (selectedIndices.size > 0) {
        onMoveSelection(selectedIndices, targetIndex);
        setSelectedIndices(new Set());
        setLastSelectedIndex(null);
      }
      setDraggedIndex(null);
    },
    [selectedIndices, onMoveSelection],
  );

  return (
    <div
      className={`tag-Order-Editor tag-selector input multiautocomplete dnd-order-mode ${
        multiline ? 'multiline' : ''
      }`}
    >
      <div className="multiautocomplete-input">
        <div
          className="input-wrapper"
          onClick={onBackgroundClick}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            // Check if the drop target is the wrapper background container itself
            if (e.target === e.currentTarget && selectedIndices.size > 0) {
              e.preventDefault();
              // Target index is set to selection.length to append items at the very end
              onMoveSelection(selectedIndices, selection.length);
              setSelectedIndices(new Set());
              setLastSelectedIndex(null);
              setDraggedIndex(null);
            }
          }}
        >
          {selection.length === 0 ? (
            <span className="">No tags available to reorder.</span>
          ) : (
            <>
              {/* Initial drop boundary offset indicator (Index position 0) */}
              <DropIndicator index={0} onDrop={handleDrop} />

              {selection.map((tag, index) => {
                const isSelected = selectedIndices.has(index);
                const isCurrentDragSource = draggedIndex === index;
                const dynamicScaleDown =
                  isSelected && draggedIndex !== null && !isCurrentDragSource;
                const wrapperClasses = [
                  'draggable-tag-wrapper',
                  isSelected ? 'selected' : '',
                  isCurrentDragSource ? 'dragging-source' : '',
                  dynamicScaleDown ? 'scale-down' : '',
                ]
                  .filter(Boolean)
                  .join(' ');

                return (
                  <React.Fragment key={`${tag.id}-${index}`}>
                    <div
                      draggable
                      onDragStart={(e) => handleDragStart(index, e)}
                      onDragEnd={handleDragEnd}
                      onClick={(e) => handleTagClick(index, e)}
                      className={wrapperClasses}
                    >
                      <Tag
                        text={tag.name}
                        color={tag.viewColor}
                        isHeader={tag.isHeader}
                        onRemove={onRemoveTag ? () => onRemoveTag(tag, index) : undefined}
                      />
                    </div>
                    {/* Appended inline drop boundary zone mapping directly to index positional offsets */}
                    <DropIndicator index={index + 1} onDrop={handleDrop} />
                  </React.Fragment>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
});

interface DropIndicatorProps {
  index: number;
  onDrop: (targetIndex: number, e: React.DragEvent) => void;
}

const DropIndicator = ({ index, onDrop }: DropIndicatorProps) => {
  const [isOver, setIsOver] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(e) => {
        setIsOver(false);
        onDrop(index, e);
      }}
      className={`drop-indicator ${isOver ? 'is-drag-over' : ''}`}
    />
  );
};
