import React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '../../contexts/StoreContext';

import { Menu, useContextMenu } from 'widgets/menus';
import { ClientExtraProperty } from '../../entities/ExtraProperty';
import { FileExtraPropertyMenuItems } from '../../containers/ContentView/menu-items';
import { useGalleryInputKeydownHandler } from '../../hooks/useHandleInputKeydown';
import { ExtraPropertyValue } from 'src/api/extraProperty';
import { ExtraPropertiesCounter, ExtraPropertyInput, Label, Factory, State } from './PropertyField';

// ── ExtraPropertyContextMenu ─────────────────────────────────────────────────

interface IExtraPropertyContextMenu {
  parentPopoverId: string;
  onDeleteExtraProperty: (extraProperty: ClientExtraProperty) => void;
  onRemoveExtraProperty: (extraProperty: ClientExtraProperty) => void;
  onRenameExtraProperty: (extraProperty: ClientExtraProperty) => void;
}

export const ExtraPropertyContextMenu = ({
  parentPopoverId,
  onDeleteExtraProperty,
  onRemoveExtraProperty,
  onRenameExtraProperty,
}: IExtraPropertyContextMenu) => {
  const getFocusableElement = useCallback(() => {
    return document
      .getElementById(parentPopoverId)
      ?.querySelector('input, textarea, button, a, select, [tabindex]') as HTMLElement | null;
  }, [parentPopoverId]);
  const handleMenuBlur = useCallback(
    (e: React.FocusEvent) => {
      if (!e.relatedTarget?.closest('[data-popover="true"]')) {
        const element = getFocusableElement();
        if (element && element instanceof HTMLElement) {
          element.focus();
          element.blur();
        }
      }
    },
    [getFocusableElement],
  );
  const handleMenuKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        const element = getFocusableElement();
        e.stopPropagation();
        if (element && element instanceof HTMLElement) {
          element.focus();
          element.blur();
        }
      }
    },
    [getFocusableElement],
  );
  const handleOnRemove = useCallback(
    (extraProperty: ClientExtraProperty) => {
      onRemoveExtraProperty(extraProperty);
      const element = getFocusableElement();
      if (element && element instanceof HTMLElement) {
        element.focus();
      }
    },
    [getFocusableElement, onRemoveExtraProperty],
  );
  const handleOnRename = useCallback(
    (extraProperty: ClientExtraProperty) => {
      const element = getFocusableElement();
      if (element && element instanceof HTMLElement) {
        element.focus();
      }
      onRenameExtraProperty(extraProperty);
    },
    [getFocusableElement, onRenameExtraProperty],
  );
  const handleOnDelete = useCallback(
    (extraProperty: ClientExtraProperty) => {
      onDeleteExtraProperty(extraProperty);
      const element = getFocusableElement();
      if (element && element instanceof HTMLElement) {
        element.focus();
      }
    },
    [getFocusableElement, onDeleteExtraProperty],
  );
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const divRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeMenuId && divRef.current) {
      divRef.current.focus();
    }
  }, [activeMenuId]);

  const show = useContextMenu();
  const handleTagContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>, extraProperty: ClientExtraProperty) => {
      event.stopPropagation();
      show(
        event.clientX,
        event.clientY,
        <div ref={divRef} onBlur={handleMenuBlur} onKeyDown={handleMenuKeyDown} tabIndex={-1}>
          <Menu>
            <FileExtraPropertyMenuItems
              extraProperty={extraProperty}
              onDelete={handleOnDelete}
              onRemove={handleOnRemove}
              onRename={handleOnRename}
            />
          </Menu>
        </div>,
      );
      setActiveMenuId(extraProperty.id);
    },
    [show, handleMenuBlur, handleMenuKeyDown, handleOnDelete, handleOnRemove, handleOnRename],
  );

  return handleTagContextMenu;
};

// ── compareByExtraPropertyName ───────────────────────────────────────────────

const compareByExtraPropertyName = (
  a: [ClientExtraProperty, [number, ExtraPropertyValue | undefined]],
  b: [ClientExtraProperty, [number, ExtraPropertyValue | undefined]],
) => {
  return a[0].name.localeCompare(b[0].name);
};

// ── ExtraPropertyListEditor ──────────────────────────────────────────────────

interface ExtraPropertyListEditorProps {
  editorState: State;
  dispatch: React.Dispatch<any>;
  counter: ExtraPropertiesCounter;
  onUpdate: (extraProperty: ClientExtraProperty, value: ExtraPropertyValue) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLElement>, extraProperty: ClientExtraProperty) => void;
}

export const ExtraPropertyListEditor = observer(
  ({ editorState, dispatch, counter, onUpdate, onContextMenu }: ExtraPropertyListEditorProps) => {
    const { uiStore, fileStore } = useStore();
    const extraProperties = Array.from(counter.get()).sort(compareByExtraPropertyName);
    const selectionSize = uiStore.fileSelection.size;
    const filteredCount = fileStore.numFilteredFiles;
    const isAllFilesSelected = uiStore.isAllFilesSelected && selectionSize !== filteredCount;
    const handleKeyDown = useGalleryInputKeydownHandler();
    const handleRename = useCallback(
      (extraProperty: ClientExtraProperty) => dispatch(Factory.enableEditing(extraProperty.id)),
      [dispatch],
    );
    const onUpdateName = useRef(() => {
      dispatch(Factory.disableEditing());
    }).current;
    return (
      <div className="extra-property-list-editor">
        {extraProperties.map(([extraProperty, [count, val]]) => (
          <ExtraPropertyListOption
            key={extraProperty.id}
            extraProperty={extraProperty}
            count={
              selectionSize > 1
                ? `${isAllFilesSelected ? '?' : count}/${
                    isAllFilesSelected ? filteredCount : selectionSize
                  }`
                : ''
            }
            value={val}
            onUpdate={onUpdate}
            isEditingName={editorState.editableNode === extraProperty.id}
            onUpdateName={onUpdateName}
            handleRename={handleRename}
            onContextMenu={onContextMenu}
            handleKeyDown={handleKeyDown}
          />
        ))}
      </div>
    );
  },
);

// ── ExtraPropertyListOption ──────────────────────────────────────────────────

interface IExtraPropertyListOptionProps {
  extraProperty: ClientExtraProperty;
  count: string | number;
  value?: ExtraPropertyValue;
  isEditingName: boolean;
  onUpdate: (extraProperty: ClientExtraProperty, value: ExtraPropertyValue) => void;
  onUpdateName: (target: EventTarget & HTMLInputElement) => void;
  handleRename: (extraProperty: ClientExtraProperty) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLElement>, extraProperty: ClientExtraProperty) => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
}

const ExtraPropertyListOption = observer(
  ({
    extraProperty,
    count,
    value,
    onUpdate,
    isEditingName,
    onUpdateName,
    handleRename,
    onContextMenu,
    handleKeyDown,
  }: IExtraPropertyListOptionProps) => {
    return (
      <div
        className="extra-property-list-option"
        onContextMenu={
          onContextMenu !== undefined ? (e) => onContextMenu(e, extraProperty) : undefined
        }
      >
        <div className="extra-property-name">
          <div className="label-container" onDoubleClick={() => handleRename(extraProperty)}>
            <Label
              text={extraProperty.name}
              setText={extraProperty.rename}
              isEditing={isEditingName}
              onSubmit={onUpdateName}
              tooltip={`${extraProperty.name} (${extraProperty.type})`}
            />
            <div className="count-hint">{count}</div>
          </div>
        </div>
        <div className="extra-property-value">
          <ExtraPropertyInput
            extraProperty={extraProperty}
            onKeyDown={handleKeyDown}
            onUpdate={onUpdate}
            value={value}
          />
        </div>
      </div>
    );
  },
);
