import React, { useReducer } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '../../contexts/StoreContext';

import { MenuButton } from 'widgets/menus';
import { ClientExtraProperty } from '../../entities/ExtraProperty';
import { useAutorun, useComputed } from '../../hooks/mobx';
import { ExtraPropertySelector } from '../ExtraPropertySelector';
import { ClientFile } from '../../entities/File';
import { runInAction } from 'mobx';
import { IconSet } from 'widgets/icons';
import {
  ExtraPropertyOverwrite,
  ExtraPropertyRemoval,
  ExtraPropertyUnAssign,
} from '../RemovalAlert';
import { debounce } from 'common/timeout';
import { ExtraPropertyValue } from 'src/api/extraProperty';
import { createPortal } from 'react-dom';
import { Placement } from '@floating-ui/core';

export type { ExtraPropertiesCounter, State } from './PropertyField';
import { ExtraPropertiesCounter, Factory, reducer } from './PropertyField';
import { ExtraPropertyContextMenu, ExtraPropertyListEditor } from './PropertyForm';

const PANEL_HEIGHT_ID = 'extra-properties-editor-height';

interface FileExtraPropertiesEditorProps {
  id?: string;
  file?: ClientFile;
  addButtonContainerID?: string;
  menuPlacement?: Placement;
}

export const FileExtraPropertiesEditor = observer(
  ({ id, file, addButtonContainerID, menuPlacement }: FileExtraPropertiesEditorProps) => {
    const { uiStore, fileStore, extraPropertyStore } = useStore();
    const [deletableExtraProperty, setDeletableExtraProperty] = useState<ClientExtraProperty>();
    const [removableExtraProperty, setRemovableExtraProperty] = useState<{
      files: ClientFile[];
      extraProperty: ClientExtraProperty;
    }>();
    const [assignableExtPropertyValue, setAssignableExtPropertyValue] = useState<{
      files: ClientFile[];
      extraProperty: ClientExtraProperty;
      value: ExtraPropertyValue;
    }>();
    const [editorState, dispatch] = useReducer(reducer, {
      editableNode: undefined,
    });

    useEffect(() => {
      runInAction(() => {
        if (file && uiStore.fileSelection.size < 1) {
          uiStore.selectFile(file);
        }
      });
    }, [file, uiStore]);

    const counter: ExtraPropertiesCounter = useComputed(() => {
      //Map of Clientstores: and a tuple of count, value
      const counter = new Map<ClientExtraProperty, [number, ExtraPropertyValue | undefined]>();
      const isMultiple = uiStore.fileSelection.size > 1;
      for (const file of uiStore.fileSelection) {
        for (const [clientExtraProperty, value] of file.extraProperties) {
          const entry = counter.get(clientExtraProperty) ?? [0, undefined];
          const [count] = entry;
          //update count and if count is bigger than one element set undefined value
          counter.set(clientExtraProperty, [count + 1, isMultiple ? undefined : value]);
        }
      }
      return counter;
    });

    // Create a copy of the selected files to ensure that callbacks
    // retain the original file selection if it changes between call and execution/confirmation.
    const files = Array.from(uiStore.fileSelection);

    const onSelect = useCallback(
      (extraProperty: ClientExtraProperty) => {
        extraPropertyStore.dispatchOnFiles(files, extraProperty, undefined, false);
      },
      [extraPropertyStore, files],
    );
    const onUpdate = useCallback(
      (extraProperty: ClientExtraProperty, value: ExtraPropertyValue) => {
        setAssignableExtPropertyValue({ files: files, extraProperty: extraProperty, value: value });
      },
      [files],
    );
    const onRemove = useCallback(
      (extraProperty: ClientExtraProperty) => {
        setRemovableExtraProperty({ files: files, extraProperty: extraProperty });
      },
      [files],
    );
    const onRename = useCallback(
      (extraProperty: ClientExtraProperty) =>
        runInAction(() => {
          let found = 0;
          if (files.length > 0) {
            for (const file of files) {
              if (file.extraProperties.has(extraProperty)) {
                found = 1;
                break;
              }
            }
          }
          if (found === 0) {
            for (const file of fileStore.fileList) {
              if (file && file.extraProperties.has(extraProperty)) {
                found = 2;
                uiStore.selectFile(file);
                break;
              }
            }
          }
          if (found === 0) {
            const firstfile = uiStore.firstFileInView;
            if (firstfile) {
              uiStore.selectFile(firstfile);
              firstfile.setExtraProperty(extraProperty, -1);
            }
          }
          dispatch(Factory.enableEditing(extraProperty.id));
        }),
      [fileStore.fileList, files, uiStore],
    );

    const extraPropertySelectorButtonID = useId();
    const extraPropertySelectorButtonMenuID = useId();
    const handleContextMenu = ExtraPropertyContextMenu({
      parentPopoverId: extraPropertySelectorButtonMenuID,
      onDeleteExtraProperty: setDeletableExtraProperty,
      onRemoveExtraProperty: onRemove,
      onRenameExtraProperty: onRename,
    });

    // Autofocus
    const buttonParentRef = useRef<HTMLDivElement>(null);
    const focusButton = useRef(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => buttonParentRef.current?.focus()));
    }).current;
    useAutorun(() => {
      if (uiStore.isFileExtraPropertiesEditorOpen) {
        focusButton();
      }
    });

    //resize
    const panelRef = useRef<HTMLDivElement>(null);
    const [storedHeight] = useState(localStorage.getItem(`${PANEL_HEIGHT_ID}-${id}`));
    useEffect(() => {
      if (!panelRef.current) {
        return;
      }
      const storeHeight = debounce((val: string) =>
        localStorage.setItem(`${PANEL_HEIGHT_ID}-${id}`, val),
      );
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (
            mutation.type == 'attributes' &&
            mutation.attributeName === 'style' &&
            panelRef.current
          ) {
            storeHeight(panelRef.current.style.height);
          }
        });
      });
      observer.observe(panelRef.current, { attributes: true });

      return () => {
        observer.disconnect();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const [buttonPopoverUpdDep, updateButtonPopover] = useReducer((x) => x + 1, 0);

    return (
      <div
        id={id}
        ref={panelRef}
        style={{ height: storedHeight ?? undefined }}
        className="extra-property-editor"
      >
        {deletableExtraProperty && (
          <ExtraPropertyRemoval
            object={deletableExtraProperty}
            onClose={() => setDeletableExtraProperty(undefined)}
          />
        )}
        {removableExtraProperty && (
          <ExtraPropertyUnAssign
            object={removableExtraProperty}
            onClose={() => setRemovableExtraProperty(undefined)}
          />
        )}
        {assignableExtPropertyValue && (
          <ExtraPropertyOverwrite
            object={assignableExtPropertyValue}
            onClose={() => setAssignableExtPropertyValue(undefined)}
          />
        )}
        <PortalButtonWrapper containerId={addButtonContainerID} onPortalCreation={focusButton}>
          <div tabIndex={-1} ref={buttonParentRef}>
            <MenuButton
              icon={IconSet.PLUS}
              text=""
              tooltip="Add extra property to file"
              id={extraPropertySelectorButtonID}
              menuID={extraPropertySelectorButtonMenuID}
              placement={menuPlacement ? menuPlacement : 'left-start'}
              strategy="fixed"
              updateDependency={buttonPopoverUpdDep}
            >
              <ExtraPropertySelector
                counter={counter}
                onSelect={onSelect}
                onChange={updateButtonPopover}
                onContextMenu={handleContextMenu}
              />
            </MenuButton>
          </div>
        </PortalButtonWrapper>
        {uiStore.fileSelection.size === 0 && (
          <div>
            <i>
              <b>No files selected</b>
            </i>
          </div> // eslint-disable-line prettier/prettier
        )}
        <ExtraPropertyListEditor
          editorState={editorState}
          dispatch={dispatch}
          counter={counter}
          onUpdate={onUpdate}
          onContextMenu={handleContextMenu}
        />
      </div>
    );
  },
);

export default FileExtraPropertiesEditor;

interface PortalButtonWrapperProps {
  containerId?: string;
  children: React.ReactNode;
  onPortalCreation?: () => void;
}

const PortalButtonWrapper = ({
  containerId,
  children,
  onPortalCreation,
}: PortalButtonWrapperProps) => {
  const [container, setContainer] = useState<HTMLElement | null | undefined>(undefined);

  useEffect(() => {
    if (!containerId) {
      return;
    }
    const element = document.getElementById(containerId);
    if (element) {
      setContainer(element);
      return;
    }
    // Fallback: observe DOM if container doesn't exist yet
    const observer = new MutationObserver(() => {
      const found = document.getElementById(containerId);
      if (found) {
        setContainer(found);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [containerId]);

  useEffect(() => {
    if (container && onPortalCreation) {
      requestAnimationFrame(() => {
        onPortalCreation();
      });
    }
  }, [container]); // eslint-disable-line react-hooks/exhaustive-deps

  return container === undefined && containerId ? null : container ? (
    createPortal(children, container)
  ) : (
    <>{children}</>
  );
};

