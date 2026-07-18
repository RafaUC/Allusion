import React, { useRef } from 'react';
import { useStore } from 'src/frontend/contexts/StoreContext';
import { FloatingPanel } from 'widgets/FloatingPanel';
import { FileExtraPropertiesEditor } from 'src/frontend/components/FileExtraPropertiesEditor';
import { FileTagsEditor } from 'src/frontend/components/FileTagsEditor';
import { observer } from 'mobx-react-lite';
import { MultiSplitPaneProps } from 'widgets/MultiSplit/MultiSplitPane';
import ExifViewer from 'src/frontend/components/ExifViewer';

const defaultPanel = {
  type: 'none',
  title: '---',
  isOpen: false,
  onBlur: () => {},
  ignoreOnBlur: (e: MouseEvent | FocusEvent) => {
    void e;
    return false;
  },
  content: <></>,
};

export const FILE_EDITOR_HEADER_ID = 'file-editors-panel-header';

const FileEditorsPanel = observer(({ className }: Partial<MultiSplitPaneProps>) => {
  const { uiStore } = useStore();

  const getActivePanel = useRef((): typeof defaultPanel => {
    if (uiStore.isFileTagsEditorOpen) {
      return {
        type: 'tags',
        isOpen: true,
        title: 'File Tags Editor',
        content: <FileTagsEditor />,
        onBlur: uiStore.closeFileTagsEditor,
        ignoreOnBlur: (e: MouseEvent | FocusEvent) => {
          void e;
          return false;
        },
      };
    }
    if (uiStore.isFileExtraPropertiesEditorOpen) {
      return {
        type: 'extra-properties',
        isOpen: true,
        title: 'Extra File Properties Editor',
        content: (
          <FileExtraPropertiesEditor
            id="outliner-extra-porperties"
            addButtonContainerID={FILE_EDITOR_HEADER_ID}
            menuPlacement="right-start"
          />
        ),
        onBlur: uiStore.closeFileExtraPropertiesEditor,
        ignoreOnBlur: (e) => {
          void e;
          return false;
        },
      };
    }
    if (uiStore.isFileExifEditorOpen) {
      return {
        type: 'exif',
        isOpen: true,
        title: 'File Info',
        content:
          uiStore.firstFileInView !== undefined ? (
            <ExifViewer file={uiStore.firstSelectedFile ?? uiStore.firstFileInView} />
          ) : (
            <></>
          ),
        onBlur: uiStore.closeFileExtifEditor,
        ignoreOnBlur: (e) => {
          void e;
          return false;
        },
      };
    }

    return defaultPanel;
  }).current;

  const activePanel = getActivePanel();

  return (
    <FloatingPanel
      id="file-editors-panel"
      type={activePanel.type}
      title={activePanel.title}
      dataOpen={activePanel.isOpen}
      isDocked={uiStore.areFileEditorsDocked}
      onBlur={activePanel.onBlur}
      ignoreOnBlur={activePanel.ignoreOnBlur}
      onToggleDock={uiStore.toggleFileEditorsDocked}
      className={className}
      children={activePanel.content}
    />
  );
});

export default FileEditorsPanel;
