import { shell } from 'electron';
import { observer } from 'mobx-react-lite';
import SysPath from 'path';
import React from 'react';

import { IconSet } from 'widgets';
import { MenuItem, MenuRadioItem, MenuSubItem } from 'widgets/menus';
import { useStore } from '../../contexts/StoreContext';
import { ClientFile } from '../../entities/File';
import {
  ClientDateSearchCriteria,
  ClientFileSearchCriteria,
  ClientNumberSearchCriteria,
  ClientStringSearchCriteria,
  ClientTagSearchCriteria,
} from '../../entities/SearchCriteria';
import { ClientTag } from '../../entities/Tag';
import { LocationTreeItemRevealer } from '../Outliner/LocationsPanel';
import { TagsTreeItemRevealer } from '../Outliner/TagsPanel/TagsTree';
import { ClientExtraProperty } from 'src/frontend/entities/ExtraProperty';
import { isFileExtensionVideo } from 'common/fs';
import { runInAction } from 'mobx';

export const MissingFileMenuItems = observer(() => {
  const { uiStore, fileStore } = useStore();
  return (
    <>
      <MenuItem
        onClick={fileStore.fetchMissingFiles}
        text="Open Recovery Panel"
        icon={IconSet.WARNING_BROKEN_LINK}
        disabled={fileStore.showsMissingContent}
      />
      <MenuItem onClick={uiStore.copyTagsToClipboard} text="Copy Tags" icon={IconSet.TAG_GROUP} />
      <MenuItem
        onClick={uiStore.openToolbarFileRemover}
        text="Delete Missing File Data"
        icon={IconSet.DELETE}
      />
    </>
  );
});

export const FileViewerMenuItems = ({ file }: { file: ClientFile }) => {
  const { uiStore, locationStore, fileStore } = useStore();

  const handleClearSelectedFileTags = () => {
    // Currently copy tags to clipboard as backup in case of error by the user
    // ToDo: add a confirm dialog?
    uiStore.copyTagsToClipboard();
    runInAction(() => {
      uiStore.fileSelection.forEach((f) => f.clearTags());
    });
  };

  const handleViewFullSize = () => {
    uiStore.selectFile(file, true);
    uiStore.enableSlideMode();
  };

  const handlePreviewWindow = () => {
    // Only clear selection if file is not already selected
    uiStore.selectFile(file, !uiStore.fileSelection.has(file));
    uiStore.openPreviewWindow();
  };

  const handleSearchSimilar = (
    e: React.MouseEvent,
    crit: ClientFileSearchCriteria | ClientFileSearchCriteria[],
  ) => {
    const crits = Array.isArray(crit) ? crit : [crit];
    if (e.ctrlKey) {
      uiStore.addSearchCriterias(crits);
    } else {
      uiStore.replaceSearchCriterias(crits);
    }
  };

  const handleCopyImageToClipboard = () => {
    uiStore.selectFile(file, true);
    uiStore.copyImageToClipboard();
  };

  return (
    <>
      <MenuItem onClick={handleViewFullSize} text="View at Full Size" icon={IconSet.SEARCH} />
      <MenuItem
        onClick={handleCopyImageToClipboard}
        text="Copy Image to Clipboard"
        icon={IconSet.COPY}
        disabled={isFileExtensionVideo(file.extension)}
      />
      <MenuItem
        onClick={handlePreviewWindow}
        text="Open In Preview Window"
        icon={IconSet.PREVIEW}
      />
      <MenuSubItem text="Tagging..." icon={IconSet.TAG_ADD}>
        <MenuItem
          onClick={uiStore.openFileTagsEditor}
          text="Open Tag Selector"
          icon={IconSet.TAG}
        />
        <MenuItem
          onClick={fileStore.tagSelectedFilesUsingTaggingService}
          text="Auto Tag Selected Using Tagging Service"
          icon={IconSet.TAG_ADD}
          disabled={fileStore.isTaggingWithService}
        />
        <MenuItem
          onClick={fileStore.readTagsFromSelectedFiles}
          text="Import Tags From Selected Files Metadata"
          icon={IconSet.TAG_ADD}
        />
        <MenuItem
          onClick={fileStore.writeTagsToSelectedFiles}
          text="Overwrite Tags in Selected Files Metadata"
          icon={IconSet.WARNING}
        />
        <MenuItem
          onClick={handleClearSelectedFileTags}
          text="Clear Selected Files Tags (and copy tags)"
          icon={IconSet.TAG_BLANCO}
        />
      </MenuSubItem>
      <MenuItem onClick={uiStore.copyTagsToClipboard} text="Copy Tags" icon={IconSet.TAG_GROUP} />
      <MenuItem
        onClick={uiStore.pasteTags}
        text="Paste Tags"
        icon={IconSet.TAG_GROUP_OPEN}
        disabled={uiStore.isTagClipboardEmpty()}
      />
      <MenuSubItem text="Search Similar Images..." icon={IconSet.MORE}>
        <MenuItem
          onClick={(e) =>
            handleSearchSimilar(
              e,
              file.tags
                .toJSON()
                .map((t) => new ClientTagSearchCriteria(undefined, 'tags', t.id, 'contains')),
            )
          }
          text="Same Tags"
          icon={IconSet.TAG}
        />
        <MenuItem
          onClick={(e) =>
            handleSearchSimilar(
              e,
              new ClientStringSearchCriteria(
                undefined,
                'absolutePath',
                SysPath.dirname(file.absolutePath) + SysPath.sep,
                'startsWith',
              ),
            )
          }
          text="Same Directory"
          icon={IconSet.FOLDER_CLOSE}
        />
        <MenuItem
          onClick={(e) =>
            handleSearchSimilar(
              e,
              new ClientStringSearchCriteria(
                undefined,
                'absolutePath',
                locationStore.get(file.locationId)!.path + SysPath.sep,
                'startsWith',
              ),
            )
          }
          text="Same Location"
        />
        <MenuItem
          onClick={(e) =>
            handleSearchSimilar(
              e,
              new ClientStringSearchCriteria(undefined, 'extension', file.extension, 'equals'),
            )
          }
          text="Same File Type"
          icon={IconSet.FILTER_FILE_TYPE}
        />
        <MenuItem
          onClick={(e) =>
            handleSearchSimilar(e, [
              new ClientNumberSearchCriteria(undefined, 'width', file.width, 'equals'),
              new ClientNumberSearchCriteria(undefined, 'height', file.height, 'equals'),
            ])
          }
          text="Same Resolution"
          icon={IconSet.ARROW_RIGHT}
        />
        <MenuItem
          onClick={(e) =>
            handleSearchSimilar(
              e,
              new ClientNumberSearchCriteria(undefined, 'size', file.size, 'equals'),
            )
          }
          text="Same File Size"
          icon={IconSet.FILTER_FILTER_DOWN}
        />
        <MenuItem
          onClick={(e) =>
            handleSearchSimilar(
              e,
              new ClientDateSearchCriteria(undefined, 'dateCreated', file.dateCreated, 'equals'),
            )
          }
          text="Same Creation Date"
          icon={IconSet.FILTER_DATE}
        />
        <MenuItem
          onClick={(e) =>
            handleSearchSimilar(
              e,
              new ClientDateSearchCriteria(undefined, 'dateModified', file.dateModified, 'equals'),
            )
          }
          text="Same Modification Date"
        />
      </MenuSubItem>
    </>
  );
};

export const SlideFileViewerMenuItems = observer(({ file }: { file: ClientFile }) => {
  const { uiStore } = useStore();

  const handlePreviewWindow = () => {
    uiStore.selectFile(file, true);
    uiStore.openPreviewWindow();
  };

  const handleCopyImageToClipboard = () => {
    uiStore.selectFile(file, true);
    uiStore.copyImageToClipboard();
  };

  const handleCopyTagsToClipboard = () => {
    uiStore.selectFile(file, true);
    uiStore.copyTagsToClipboard();
  };

  const handlePasteTags = () => {
    uiStore.selectFile(file, true);
    uiStore.pasteTags();
  };

  return (
    <>
      <MenuItem
        onClick={handleCopyImageToClipboard}
        text="Copy Image to Clipboard"
        icon={IconSet.COPY}
        disabled={isFileExtensionVideo(file.extension)}
      />
      <MenuItem onClick={handleCopyTagsToClipboard} text="Copy Tags" icon={IconSet.TAG_GROUP} />
      <MenuItem
        onClick={handlePasteTags}
        text="Paste Tags"
        icon={IconSet.TAG_GROUP_OPEN}
        disabled={uiStore.isTagClipboardEmpty()}
      />
      <MenuItem
        onClick={handlePreviewWindow}
        text="Open In Preview Window"
        icon={IconSet.PREVIEW}
      />

      <MenuSubItem text="Upscale filtering..." icon={IconSet.VIEW_GRID}>
        <MenuRadioItem
          onClick={uiStore.setUpscaleModeSmooth}
          checked={uiStore.upscaleMode === 'smooth'}
          text="Smooth"
        />
        <MenuRadioItem
          onClick={uiStore.setUpscaleModePixelated}
          checked={uiStore.upscaleMode === 'pixelated'}
          text="Pixelated"
        />
      </MenuSubItem>
    </>
  );
});

export const ExternalAppMenuItems = observer(({ file }: { file: ClientFile }) => {
  const { uiStore } = useStore();
  return (
    <>
      <MenuItem
        onClick={() => uiStore.openExternal()}
        text="Open External"
        icon={IconSet.OPEN_EXTERNAL}
        disabled={file.isBroken}
      />
      <MenuItem
        onClick={() =>
          LocationTreeItemRevealer.instance.revealSubLocation(file.locationId, file.absolutePath)
        }
        text="Reveal in Locations Panel"
        icon={IconSet.TREE_LIST}
      />
      <MenuItem
        onClick={() => shell.showItemInFolder(file.absolutePath)}
        text="Reveal in File Browser"
        icon={IconSet.FOLDER_CLOSE}
        disabled={file.isBroken}
      />
      <MenuItem
        onClick={uiStore.openMoveFilesToTrash}
        text={`Delete file${uiStore.fileSelection.size > 1 ? 's' : ''}`}
        icon={IconSet.DELETE}
        disabled={file.isBroken}
      />
    </>
  );
});

export const FileTagMenuItems = observer(({ file, tag }: { file?: ClientFile; tag: ClientTag }) => {
  const { uiStore } = useStore();
  const ctxTags = uiStore.getTagContextItems(tag.id);
  return (
    <>
      <MenuItem
        onClick={() => TagsTreeItemRevealer.instance.revealTag(tag)}
        text="Reveal in Tags Panel"
        icon={IconSet.TREE_LIST}
        disabled={file ? file.isBroken : false}
      />
      <MenuItem
        onClick={() => uiStore.openTagPropertiesEditor(tag)}
        text="Edit Tag"
        icon={IconSet.EDIT}
      />
      <MenuItem
        onClick={() => uiStore.openTagMovePanel(tag)}
        text="Move Tag To"
        icon={IconSet.TAG_GROUP}
      />
      <MenuItem
        onClick={() => uiStore.openTagMergePanel(tag)}
        text="Merge Tag With"
        icon={IconSet.TAG_GROUP}
        disabled={ctxTags.some((tag) => tag.subTags.length > 0)}
      />
      <MenuItem
        onClick={() => file && file.removeTag(tag)}
        text="Unassign Tag From File"
        icon={IconSet.TAG_BLANCO}
      />
    </>
  );
});

export const EditorTagSummaryItems = ({
  tag,
  beforeSelect,
}: {
  tag: ClientTag;
  beforeSelect: () => void;
}) => {
  const { uiStore } = useStore();
  const ctxTags = uiStore.getTagContextItems(tag.id);
  return (
    <>
      <MenuItem
        onClick={() => {
          beforeSelect();
          TagsTreeItemRevealer.instance.revealTag(tag);
        }}
        text="Reveal in Tags Panel"
        icon={IconSet.TREE_LIST}
      />
      <MenuItem
        onClick={() => {
          beforeSelect();
          uiStore.openTagPropertiesEditor(tag);
        }}
        text="Edit Tag"
        icon={IconSet.EDIT}
      />
      <MenuItem
        onClick={() => uiStore.openTagMovePanel(tag)}
        text="Move To"
        icon={IconSet.TAG_GROUP}
      />
      <MenuItem
        onClick={() => uiStore.openTagMergePanel(tag)}
        text="Merge With"
        icon={IconSet.TAG_GROUP}
        disabled={ctxTags.some((tag) => tag.subTags.length > 0)}
      />
    </>
  );
};

export const FileExtraPropertyMenuItems = observer(
  ({
    extraProperty,
    onDelete,
    onRemove,
    onRename,
  }: {
    extraProperty: ClientExtraProperty;
    onDelete: (extraProperty: ClientExtraProperty) => void;
    onRemove: (extraProperty: ClientExtraProperty) => void;
    onRename: (extraProperty: ClientExtraProperty) => void;
  }) => {
    const { uiStore } = useStore();

    const isMultiple = uiStore.fileSelection.size > 1;
    return (
      <>
        <MenuItem
          onClick={() => onRemove(extraProperty)}
          text={`Remove extra property from ${isMultiple ? 'files' : 'file'}`}
          icon={IconSet.CLOSE}
        />
        <MenuItem onClick={() => onRename(extraProperty)} text="Rename" icon={IconSet.EDIT} />
        <MenuItem
          onClick={() => onDelete(extraProperty)}
          text="Delete extra property and remove it from all files"
          icon={IconSet.DELETE}
        />
      </>
    );
  },
);
