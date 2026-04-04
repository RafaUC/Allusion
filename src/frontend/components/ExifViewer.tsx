import React, { useEffect, useState } from 'react';
import { ClientFile } from '../entities/File';
import { useStore } from '../contexts/StoreContext';
import { IconSet } from 'widgets/icons';
import { MenuButton, MenuItem } from 'widgets/menus';
import { Button } from 'widgets/button';
import ImageInfo from './ImageInfo';

interface ExifViewerProps {
  file: ClientFile;
}

const defaultGroup = '_info';
const STORAGE_KEY = 'exif-viewer-selected-group';

const ExifViewer = ({ file }: ExifViewerProps) => {
  const { exifTool } = useStore();
  const [exifData, setExifData] = useState<{ [key: string]: { [key: string]: any } }>({});
  const [selectedGroup, setSelectedgroup] = useState<string>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? saved : defaultGroup;
  });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const selectedData = exifData[selectedGroup] ?? { '(No data)': '' };

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, selectedGroup);
  }, [selectedGroup]);

  useEffect(() => {
    exifTool
      .readData(file.absolutePath)
      .then((data) => {
        setExifData(data);
      })
      .catch((e) => console.error(e));
  }, [exifTool, file.absolutePath]); // eslint-disable-line react-hooks/exhaustive-deps

  const buttonText: React.ReactText = (
    <div className="menu-button-text-elem">
      {`Exif ${selectedGroup === defaultGroup ? 'Metadata' : ` (${selectedGroup})`}`}
      {IconSet.ARROW_DOWN}
    </div>
  ) as any;

  return (
    <div id="exif-viewer">
      <div
        className={`exif-viewer-toolbar ${
          selectedGroup === defaultGroup ? 'is-default' : 'is-exif'
        }`}
      >
        <Button text="Info" onClick={() => setSelectedgroup(defaultGroup)} />
        <MenuButton
          icon={<></>}
          text={buttonText}
          tooltip="Select exif metadata to view"
          id="exif-viewer-menu"
          menuID="__exif-viewer-menu-options"
        >
          {Object.keys(exifData)
            .sort()
            .map((key) => (
              <MenuItem key={key} onClick={() => setSelectedgroup(key)} text={key} />
            ))}
        </MenuButton>
      </div>
      {selectedGroup === defaultGroup ? (
        <ImageInfo file={file} />
      ) : (
        <table id="exif-info">
          <tbody>
            {Object.entries(selectedData).map(([field, value]) => (
              <tr key={field}>
                <th scope="row">{field}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default ExifViewer;
