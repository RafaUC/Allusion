import fse from 'fs-extra';
import { action } from 'mobx';
import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ellipsize, humanFileSize } from 'common/fmt';
import { encodeFilePath, isFileExtension3DModel, isFileExtensionVideo } from 'common/fs';
import { IconButton, IconSet } from 'widgets';
import { useStore } from '../../contexts/StoreContext';
import { ClientFile } from '../../entities/File';
import { usePromise } from '../../hooks/usePromise';
import { CommandDispatcher } from './Commands';
import { ITransform } from './Masonry/layout-helpers';
import { GalleryVideoPlaybackMode } from 'src/frontend/stores/UiStore';
import { thumbnailMaxSize } from 'common/config';
import { IncrementalTagItems } from 'src/frontend/components/FileTagsEditor';

interface ItemProps {
  file: ClientFile;
  mounted: boolean;
  // Will use the original image instead of the thumbnail
  forceNoThumbnail?: boolean;
  hovered?: boolean;
  galleryVideoPlaybackMode?: GalleryVideoPlaybackMode;
}

interface MasonryItemProps extends ItemProps {
  forceNoThumbnail: boolean;
  transform: ITransform;
}

export const MasonryCell = observer(
  ({
    file,
    mounted,
    forceNoThumbnail,
    transform: [width, height, top, left],
  }: MasonryItemProps) => {
    const { uiStore, fileStore } = useStore();
    const [isHovered, setIsHovered] = useState(false);
    const style = { height, width, transform: `translate(${left}px,${top}px)` };
    const eventManager = useMemo(() => new CommandDispatcher(file), [file]);

    const handleMouseEnter = useCallback((): void => {
      setIsHovered(true);
    }, []);
    const handleMouseLeave = useCallback((): void => {
      setIsHovered(false);
    }, []);

    const cellContent = () => (
      <div data-masonrycell aria-selected={uiStore.fileSelection.has(file)} style={style}>
        {uiStore.isRefreshing ? null : renderThumbnailContent()}
      </div>
    );

    const renderThumbnailContent = () => (
      <>
        <div
          className={`thumbnail${file.isBroken ? ' thumbnail-broken' : ''}`}
          onClick={eventManager.select}
          onDoubleClick={eventManager.preview}
          onContextMenu={eventManager.showContextMenu}
          onDragStart={eventManager.dragStart}
          onDragEnter={eventManager.dragEnter}
          onDragOver={eventManager.dragOver}
          onDragLeave={eventManager.dragLeave}
          onDrop={eventManager.drop}
          onDragEnd={eventManager.dragEnd}
          onMouseEnter={
            uiStore.galleryVideoPlaybackMode === 'hover' &&
            (isFileExtensionVideo(file.extension) || file.extension === 'gif')
              ? handleMouseEnter
              : (): void => {}
          }
          onMouseLeave={
            uiStore.galleryVideoPlaybackMode === 'hover' &&
            (isFileExtensionVideo(file.extension) || file.extension === 'gif')
              ? handleMouseLeave
              : (): void => {}
          }
        >
          <Thumbnail
            mounted={mounted}
            file={file}
            forceNoThumbnail={forceNoThumbnail}
            hovered={isHovered}
            galleryVideoPlaybackMode={uiStore.galleryVideoPlaybackMode}
          />
        </div>
        {file.isBroken === true && !fileStore.showsMissingContent && (
          <IconButton
            className="thumbnail-broken-overlay"
            icon={IconSet.WARNING_BROKEN_LINK}
            onClick={async (e) => {
              e.stopPropagation();
              e.preventDefault();
              await fileStore.fetchMissingFiles();
            }}
            text="This image could not be found. Open the recovery view."
          />
        )}

        {(uiStore.isThumbnailFilenameOverlayEnabled ||
          uiStore.isThumbnailResolutionOverlayEnabled) && (
          <ThumbnailOverlay
            file={file}
            showFilename={uiStore.isThumbnailFilenameOverlayEnabled}
            showResolution={uiStore.isThumbnailResolutionOverlayEnabled}
          />
        )}

        {/* Show tags depending of thumbnailTagOverlayMode */}
        {(uiStore.thumbnailTagOverlayMode === 'all' ||
          (uiStore.thumbnailTagOverlayMode === 'selected' && uiStore.fileSelection.has(file))) &&
          (!mounted ? (
            <span className="thumbnail-tags" />
          ) : (
            <ThumbnailTags file={file} eventManager={eventManager} />
          ))}
      </>
    );
    return cellContent();
  },
);

// TODO: When a filename contains https://x/y/z.abc?323 etc., it can't be found
// e.g. %2F should be %252F on filesystems. Something to do with decodeURI, but seems like only on the filename - not the whole path
export const Thumbnail = observer(
  ({ file, mounted, forceNoThumbnail, hovered, galleryVideoPlaybackMode }: ItemProps) => {
    const { uiStore, imageLoader, backend } = useStore();
    const { thumbnailPath, isBroken } = file;
    const [isPlaying, setIsPlaying] = useState<boolean | undefined>(undefined);
    const [useVideo, setUseVideo] = useState<boolean>(false);
    // This will check whether a thumbnail exists, generate it if needed
    // this arguments work as dependencies to re-execute the promise
    const imageSource = usePromise(
      file,
      isBroken,
      mounted,
      thumbnailPath, // dependency to re-execute
      uiStore.isList || (!forceNoThumbnail && !isPlaying),
      async (file, isBroken, mounted, thumbnailPath, useThumbnail) => {
        // If it is broken, only show thumbnail if it exists.
        if (!mounted || isBroken === true) {
          // fse.pathExists doesn't work if the path have url parameters
          if (await fse.pathExists(thumbnailPath.split('?')[0])) {
            return thumbnailPath;
          } else {
            throw new Error('No thumbnail available.');
          }
        }

        if (useThumbnail) {
          //this line will throw an exception if the thumbnail generation gets rejected / throw
          await imageLoader.ensureThumbnail(file);
          const thumb = getThumbnail(file);
          if (isFileExtension3DModel(file.extension)) {
            backend.embedFileFromThumbnail(file.id, thumb.split('?')[0]).catch(console.warn);
          }
          return thumb;
        } else {
          const src = await imageLoader.getImageSrc(file);
          if (src !== undefined) {
            return src;
          } else {
            throw new Error('No thumbnail available.');
          }
        }
      },
    );

    // Even though all thumbnail errors should be caught in the above usePromise,
    // there is a chance that the image cannot be loaded, and we don't want to show broken image icons
    const fileId = file.id;
    const fileIdRef = useRef(fileId);
    const videoRef = useRef<HTMLVideoElement>(null);
    const thumbnailRef = useRef<HTMLImageElement>(null);
    const [loadError, setLoadError] = useState(false);
    const [loading, setLoading] = useState(true);
    const [src, setSrc] = useState(thumbnailPath);
    const handleImageError = useCallback(() => {
      if (fileIdRef.current === fileId) {
        setLoadError(true);
      }
    }, [fileId]);
    const handleLoad = useCallback(() => {
      if (fileIdRef.current === fileId) {
        setLoading(false);
        if (videoRef.current) {
          videoRef.current.style.setProperty('display', 'block');
          thumbnailRef.current?.style.setProperty('display', 'none');
        }
      }
    }, [fileId]);
    useEffect(() => {
      fileIdRef.current = fileId;
      setLoadError(false);
    }, [fileId]);
    useEffect(() => {
      if (imageSource.tag === 'ready') {
        if ('ok' in imageSource.value) {
          setSrc(imageSource.value.ok);
          setUseVideo((isPlaying ?? false) && isFileExtensionVideo(file.extension));
        }
        setLoadError(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [imageSource.tag, imageSource]);

    // Plays and pauses media
    useEffect(() => {
      if (!(file.extension === 'gif' || isFileExtensionVideo(file.extension))) {
        return;
      }
      if (hovered) {
        setIsPlaying(true);
      } else if (isPlaying !== undefined) {
        setIsPlaying(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file.extension, hovered]);
    useEffect(() => {
      if (!(file.extension === 'gif' || isFileExtensionVideo(file.extension))) {
        return;
      }
      if (galleryVideoPlaybackMode === 'auto') {
        setIsPlaying(true);
      } else if (isPlaying !== undefined) {
        setIsPlaying(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file.extension, galleryVideoPlaybackMode]);

    const is_lowres = !(file.width > thumbnailMaxSize || file.height > thumbnailMaxSize);
    const is_pixelated = is_lowres && uiStore.upscaleMode === 'pixelated';
    const autoPlay = (galleryVideoPlaybackMode === 'auto' || hovered) ?? false;

    const props = useMemo(() => {
      const props = {
        src: encodeFilePath(src),
        'data-file-id': file.id,
        onError: handleImageError,
        style: is_pixelated ? { imageRendering: 'pixelated' as any } : {},
      };
      if (useVideo) {
        return {
          ...props,
          muted: true,
          loop: true,
          onCanPlay: handleLoad,
          autoPlay: autoPlay,
        };
      } else {
        return {
          ...props,
          alt: '',
          onLoad: handleLoad,
        };
      }
    }, [autoPlay, file.id, handleImageError, handleLoad, is_pixelated, src, useVideo]);

    if (!mounted) {
      return <span className="image-placeholder" />;
    }
    if (loadError) {
      return <span className="image-loading" />;
    }
    if (imageSource.tag === 'ready' && 'err' in imageSource.value) {
      return <span className="image-error" />;
    }
    return (
      <>
        {useVideo ? (
          <>
            <video ref={videoRef} {...props} style={{ ...props.style, display: 'none' }} />
            <img
              ref={thumbnailRef}
              src={encodeFilePath(file.thumbnailPath)}
              style={{ ...props.style, display: loading ? 'none' : 'block' }}
            />
          </>
        ) : (
          <img
            ref={thumbnailRef}
            {...props}
            style={{ ...props.style, display: loading ? 'none' : 'block' }}
          />
        )}
        {loading && <span className="image-loading" />}
      </>
    );
  },
);

const getThumbnail = action((file: ClientFile) => file.thumbnailPath);

export const ThumbnailTags = observer(
  ({ file, eventManager }: { file: ClientFile; eventManager: CommandDispatcher }) => {
    return (
      <span
        className="thumbnail-tags"
        onClick={eventManager.select}
        onDoubleClick={eventManager.preview}
        onContextMenu={eventManager.showContextMenu}
        onDragStart={eventManager.dragStart}
        onDragEnter={eventManager.dragEnter}
        onDragOver={eventManager.dragOver}
        onDragLeave={eventManager.dragLeave}
        onDrop={eventManager.drop}
        onDragEnd={eventManager.dragEnd}
      >
        <IncrementalTagItems
          tags={file.sortedInheritedTags}
          onContextMenu={eventManager.showTagContextMenu}
        />
      </span>
    );
  },
);

/*
const TagWithHint = observer(
  ({
    tag,
    onContextMenu,
  }: {
    tag: ClientTag;
    onContextMenu: (e: MousePointerEvent, tag: ClientTag) => void;
  }) => {
    return (
      <Tag
        text={tag.name}
        color={tag.viewColor}
        isHeader={tag.isHeader}
        tooltip={tag.path
          .map((v) => (v.startsWith('#') ? '&nbsp;<b>' + v.slice(1) + '</b>&nbsp;' : v))
          .join(' › ')}
        onContextMenu={(e) => onContextMenu(e, tag)}
      />
    );
  },
);
*/

const ThumbnailOverlay = ({
  file,
  showFilename,
  showResolution,
}: {
  file: ClientFile;
  showFilename: boolean;
  showResolution: boolean;
}) => {
  const title = `${ellipsize(file.absolutePath, 80, 'middle')}, ${file.width}x${
    file.height
  }, ${humanFileSize(file.size)}`;

  return (
    <div className="thumbnail-overlay" data-tooltip={title} tabIndex={-1} onBlur={deselect}>
      {showFilename && (
        <div className="thumbnail-filename" data-tooltip={title}>
          {file.name}
        </div>
      )}

      {showResolution && (
        <div className="thumbnail-resolution" data-tooltip={title}>
          {file.width}⨯{file.height}
        </div>
      )}
    </div>
  );
};

const deselect = () => {
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
  }
};
