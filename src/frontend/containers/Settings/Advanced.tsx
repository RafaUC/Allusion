import { getThumbnailPath, isDirEmpty } from 'common/fs';
import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import React, { useEffect, useState } from 'react';
import FileInput from 'src/frontend/components/FileInput';
import { RendererMessenger } from 'src/ipc/renderer';
import { Button, ButtonGroup, IconSet, Toggle } from 'widgets';
import { useStore } from '../../contexts/StoreContext';
import { moveThumbnailDir } from '../../image/ThumbnailGeneration';
import { ClearDbButton } from '../ErrorBoundary';
import { Callout } from 'widgets/notifications';
import ExternalLink from 'src/frontend/components/ExternalLink';
import { LoggerConfig } from 'src/logger/types';
import { RendererLoggerController } from 'src/logger/logger-renderer';

export const Advanced = observer(() => {
  const { uiStore, fileStore } = useStore();
  const thumbnailDirectory = uiStore.thumbnailDirectory;

  const [defaultThumbnailDir, setDefaultThumbnailDir] = useState('');
  const [defaultLogsDir, setDefaultLogsDir] = useState('');
  const [loggerConfig, setLoggerConfig] = useState<Partial<LoggerConfig>>({});

  useEffect(() => {
    RendererMessenger.getDefaultThumbnailDirectory().then(setDefaultThumbnailDir);
    RendererMessenger.getDefaultLogsDirectory().then(setDefaultLogsDir);
    RendererLoggerController.getCurrentConfig().then(setLoggerConfig);
  }, []);

  const handleToggleLogging = async (isEnabled: boolean) => {
    setLoggerConfig((prev) => ({ ...prev, consoleEnabled: isEnabled }));
    const updated = await RendererLoggerController.setConsoleEnabled(isEnabled);
    if (updated.success) {
      setLoggerConfig(updated.currentConfig);
    }
  };

  const handleTogglePrivacy = async (isPrivacyActive: boolean) => {
    setLoggerConfig((prev) => ({ ...prev, privacyActive: isPrivacyActive }));
    const updated = await RendererLoggerController.setPrivacyActive(isPrivacyActive);
    if (updated.success) {
      setLoggerConfig(updated.currentConfig);
    }
  };

  const changeThumbnailDirectory = async (newDir: string) => {
    const oldDir = thumbnailDirectory;

    // Move thumbnail files
    await moveThumbnailDir(oldDir, newDir);
    uiStore.setThumbnailDirectory(newDir);

    // Reset thumbnail paths for those that already have one
    runInAction(() => {
      for (const f of fileStore.fileList) {
        if (f && f.thumbnailPath && f.thumbnailPath !== f.absolutePath) {
          f.setThumbnailPath(getThumbnailPath(f.absolutePath, newDir));
        }
      }
    });
  };

  const browseThumbnailDirectory = async ([newDir]: [string, ...string[]]) => {
    if (!(await isDirEmpty(newDir))) {
      if (
        window.confirm(
          `The directory you picked is not empty. Allusion might delete any files inside of it. Do you still wish to pick this directory?\n\nYou picked: ${newDir}`,
        )
      ) {
        changeThumbnailDirectory(newDir);
      }
    } else {
      changeThumbnailDirectory(newDir);
    }
  };

  return (
    <>
      {/* Todo: Add support to toggle this */}
      {/* <Switch checked={true} onChange={() => alert('Not supported yet')} label="Generate thumbnails" /> */}
      <Callout icon={IconSet.INFO}>
        By default thumbnails are stored in the{' '}
        <ExternalLink url={defaultThumbnailDir}>temporary files directory</ExternalLink>.
      </Callout>
      <div className="filepicker">
        <FileInput
          className="btn-minimal filepicker-input"
          options={{
            properties: ['openDirectory'],
            defaultPath: thumbnailDirectory,
          }}
          onChange={browseThumbnailDirectory}
        >
          Change...
        </FileInput>
        <h3 className="filepicker-label">Thumbnail Directory</h3>
        <div className="filepicker-path">{thumbnailDirectory}</div>
      </div>

      <h3>Development</h3>
      <ButtonGroup>
        <ClearDbButton />
        <Button
          onClick={RendererMessenger.toggleDevTools}
          styling="outlined"
          icon={IconSet.CHROME_DEVTOOLS}
          text="Toggle DevTools"
        />
      </ButtonGroup>

      <h3>Logging</h3>

      <Callout icon={IconSet.INFO}>
        Activating this feature saves a record of application events, processes, and errors diagnose
        and troubleshoot issues. If you are experiencing problems, please enable this option,
        reproduce the incorrect behavior, and attach the log file to your GitHub issue report.
        <br />
        You can find the active log file in the{' '}
        <ExternalLink url={defaultLogsDir}>logs directory</ExternalLink>.
      </Callout>
      <div className="vstack">
        <Toggle checked={!!loggerConfig.consoleEnabled} onChange={handleToggleLogging}>
          Enable console logs and file logging
        </Toggle>
        <Toggle checked={!!loggerConfig.privacyActive} onChange={handleTogglePrivacy}>
          Obfuscate directory paths, filenames, and tag names
        </Toggle>
      </div>
    </>
  );
});
