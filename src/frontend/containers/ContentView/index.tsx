import React, { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';

import { useStore } from '../../contexts/StoreContext';

import { IconSet } from 'widgets';
import { MenuSubItem, Menu, useContextMenu } from 'widgets/menus';

import Placeholder from './Placeholder';
import Layout from './LayoutSwitcher';

import { LayoutMenuItems, SortMenuItems } from '../AppToolbar/Menus';
import { useTagDnD } from 'src/frontend/contexts/TagDnDContext';
import { MoveFilesToTrashBin } from 'src/frontend/components/RemovalAlert';
import { useAction } from 'src/frontend/hooks/mobx';
import useIsWindowMaximized from 'src/frontend/hooks/useIsWindowMaximized';
import { ManyOpenExternal } from 'src/frontend/components/WarningAlert';
import ContentProgressBar from './ContentProgressBar';

const ContentView = observer(() => {
  const {
    uiStore,
    fileStore: { fileList, fileDimensions },
  } = useStore();

  return (
    <div
      id="content-view"
      className={`thumbnail-${uiStore.thumbnailSize} thumbnail-${uiStore.thumbnailShape}`}
    >
      <ContentProgressBar />
      {fileList.length === 0 || fileDimensions.length === 0 ? <Placeholder /> : <Content />}
    </div>
  );
});

const Content = observer(() => {
  const { fileStore, uiStore } = useStore();
  const dndData = useTagDnD();
  const { fileList } = fileStore;
  const [contentRect, setContentRect] = useState({ width: 1, height: 1 });
  const container = useRef<HTMLDivElement>(null);
  const isMaximized = useIsWindowMaximized();

  const show = useContextMenu();
  const handleContextMenu = useAction((e: React.MouseEvent) => {
    if (!uiStore.isSlideMode) {
      show(
        e.clientX,
        e.clientY,
        <Menu>
          <MenuSubItem icon={IconSet.VIEW_GRID} text="View method...">
            <LayoutMenuItems />
          </MenuSubItem>
          <MenuSubItem icon={IconSet.FILTER_NAME_DOWN} text="Sort by...">
            <SortMenuItems />
          </MenuSubItem>
        </Menu>,
      );
    }
  });

  const resizeObserver = useRef(
    new ResizeObserver((entries) => {
      const {
        contentRect: { width, height },
      } = entries[0];
      setContentRect({ width, height });
    }),
  );

  useEffect(() => {
    const observer = resizeObserver.current;
    if (container.current) {
      resizeObserver.current.observe(container.current);
    }
    return () => observer.disconnect();
  }, [fileList.length]);

  const isDroppingTagOnSelection =
    dndData.target !== undefined && uiStore.fileSelection.has(dndData.target);

  const clearFileSelection = useAction((e: React.MouseEvent | React.KeyboardEvent) => {
    const isLayout = e.currentTarget.firstElementChild?.contains(e.target as Node);
    if (!uiStore.isSlideMode && isLayout) {
      uiStore.clearFileSelection();
    }
  });

  const handleKeyDown = useAction((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (!uiStore.isSlideMode) {
        uiStore.clearFileSelection();
        e.stopPropagation();
      }
    }
  });

  return (
    <div
      ref={container}
      id="gallery-content"
      className={isMaximized ? '' : 'unmaximized'}
      tabIndex={-1}
      data-show-overlay={
        uiStore.isThumbnailFilenameOverlayEnabled || uiStore.isThumbnailResolutionOverlayEnabled
      }
      data-selected-file-dropping={isDroppingTagOnSelection}
      onContextMenu={handleContextMenu}
      // Clear selection when clicking on the background, unless in slide mode: always needs an active image
      onClick={clearFileSelection}
      onKeyDown={handleKeyDown}
    >
      <Layout contentRect={contentRect} />
      <MoveFilesToTrashBin />
      <ManyOpenExternal />
    </div>
  );
});

Content.displayName = 'Gallery';

export default ContentView;
