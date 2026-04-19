import { chromeExtensionUrl, firefoxExtensionUrl } from 'common/config';
import { observer } from 'mobx-react-lite';
import React, { useState } from 'react';
import ExternalLink from 'src/frontend/components/ExternalLink';
import { RendererMessenger } from 'src/ipc/renderer';
import { IconSet, Toggle } from 'widgets';
import { Callout } from 'widgets/notifications';
import { useStore } from '../../contexts/StoreContext';
import FileInput from 'src/frontend/components/FileInput';
import { useGalleryInputKeydownHandler } from 'src/frontend/hooks/useHandleInputKeydown';
import UiStore from 'src/frontend/stores/UiStore';

export const BackgroundProcesses = observer(() => {
  const { uiStore, locationStore, fileStore } = useStore();

  const importDirectory = uiStore.importDirectory;
  const browseImportDirectory = async ([newDir]: [string, ...string[]]) => {
    if (locationStore.locationList.some((loc) => newDir.startsWith(loc.path))) {
      await RendererMessenger.setClipServerImportLocation(newDir);
      uiStore.setImportDirectory(newDir);
    } else {
      alert('Please choose a location or any of its subfolders.');
      return;
    }
  };

  const [isRunInBackground, setRunInBackground] = useState(RendererMessenger.isRunningInBackground);
  const toggleRunInBackground = (value: boolean) => {
    setRunInBackground(value);
    RendererMessenger.setRunInBackground({ isRunInBackground: value });
  };

  const [isClipEnabled, setClipServerEnabled] = useState(RendererMessenger.isClipServerEnabled);
  const toggleClipServer = (value: boolean) => {
    setClipServerEnabled(value);
    RendererMessenger.setClipServerEnabled({ isClipServerRunning: value });
  };

  return (
    <>
      <TaggingServiceConfig />
      <h3>Browser Extension</h3>
      <Callout icon={IconSet.INFO}>
        You need to install the browser extension before either in the{' '}
        <ExternalLink url={chromeExtensionUrl}>Chrome Web Store</ExternalLink> or{' '}
        <ExternalLink url={firefoxExtensionUrl}>Firefox Browser Add-Ons</ExternalLink>.
      </Callout>
      <Callout icon={IconSet.INFO}>
        To keep the browser extension working even when Allusion is closed, you must enable the Run
        in background option.
      </Callout>
      <Callout icon={IconSet.INFO}>
        For the browser extension to work, choose a download folder that is in one of your locations
        already added to Allusion.
      </Callout>
      <Toggle
        checked={isClipEnabled}
        onChange={
          isClipEnabled || importDirectory
            ? toggleClipServer
            : () => alert('Please choose a download directory first.')
        }
      >
        Run browser extension
      </Toggle>
      <br />
      <br />
      <Toggle checked={isRunInBackground} onChange={toggleRunInBackground}>
        Run in background
      </Toggle>
      <div className="filepicker">
        <FileInput
          className="btn-minimal filepicker-input"
          options={{
            properties: ['openDirectory'],
            defaultPath: importDirectory,
          }}
          onChange={browseImportDirectory}
        >
          Change...
        </FileInput>
        <h4 className="filepicker-label">Download Directory</h4>
        <div className="filepicker-path">{uiStore.importDirectory || 'Not set'}</div>
      </div>
      <br />
      <br />

        <h3>Semantic Search</h3>
        <Callout icon={IconSet.INFO}>
          Semantic model status: <strong>{fileStore.semanticStatusLabel}</strong>
          {fileStore.semanticModelId ? ` (${fileStore.semanticModelId})` : ''}
        </Callout>
        {fileStore.semanticStatusError ? (
          <Callout icon={IconSet.WARNING}>{fileStore.semanticStatusError}</Callout>
        ) : null}
        <label>
          Semantic Result Count
          <select
            value={fileStore.semanticTopK}
            onChange={(event) => fileStore.setSemanticTopK(Number(event.target.value))}
          >
            {[50, 100, 256, 512, 1000].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <br />
        <label>
          Semantic Score Threshold
          <input
            type="number"
            min={-1}
            max={1}
            step={0.01}
            value={fileStore.semanticMinScore}
            onChange={(event) => fileStore.setSemanticMinScore(Number(event.target.value))}
          />
        </label>
        <br />
        <button className="btn-minimal" onClick={() => void fileStore.refreshSemanticStatus()}>
          Refresh Semantic Status
        </button>
        <button className="btn-minimal" onClick={() => void fileStore.warmupSemanticModel()}>
          Warmup Semantic Model
        </button>
        <button className="btn-minimal" onClick={() => void fileStore.reindexSemanticEmbeddings()}>
          Reindex Semantic Embeddings
        </button>
        <br />
        <br />
    </>
  );
});

const TaggingServiceConfig = observer(() => {
  const { taggingServiceURL, setTaggingServiceURL } = useStore().uiStore;
  const prehost = 'http://localhost';

  const posthost = taggingServiceURL.startsWith(prehost)
    ? taggingServiceURL.slice(prehost.length)
    : '';

  const handleKeyDown = useGalleryInputKeydownHandler();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    //use URL for validations
    let newPosthost = e.target.value.replace(prehost, '');
    const url = new URL(newPosthost, prehost);
    //Remove any hostname if present when pasting the full URL.
    newPosthost = (url.pathname + url.search + url.hash).replace('/', '');
    if (newPosthost && !newPosthost.startsWith(':') && !newPosthost.startsWith('/')) {
      newPosthost = '/' + newPosthost;
    }
    setTaggingServiceURL(prehost + newPosthost);
  };

  // Custom and minimalistic implementation inspired/based on cmeka's implementation: https://github.com/cmeka/OneFolder/commit/b0d7e12
  return (
    <>
      <h3>Local Tagging Service API URL</h3>
      <Callout icon={IconSet.INFO}>
        A tagging service such as{' '}
        <ExternalLink url="https://github.com/cmeka/media-tag-service">
          media-tag-service
        </ExternalLink>{' '}
        or any custom tagging endpoint must be running.
      </Callout>
      <Callout icon={IconSet.INFO}>
        <div style={{ overflowY: 'auto', height: '105px' }}>
          {'The endpoint must accept a JSON request with the format:'}
          <pre>{'{ "file": "<absolute_path>" }'}</pre>
          {'and respond with a JSON in the format:'}
          <pre>
            {'{'}
            <br />
            {'  "tags": ['}
            <br />
            {'    { "name": "<tag1_name>" },'}
            <br />
            {'    { "name": "<tag2_name>" },'}
            <br />
            {'    ... etc.'}
            <br />
            {'  ]'}
            <br />
            {'}'}
          </pre>
        </div>
      </Callout>

      <div className="split-input-wrapper input">
        <span style={{ color: 'var(--text-color-muted)' }}>{prehost}</span>
        <input
          type="text"
          className="flex-1 border p-1"
          value={posthost}
          onKeyDown={handleKeyDown}
          onChange={handleChange}
        />
      </div>
      <br />
      <TaggingServiceParallelRequests />
      <br />
      <br />
    </>
  );
});

const TaggingServiceParallelRequests = observer(() => {
  const { uiStore } = useStore();

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = Number(event.target.value);
    uiStore.setTaggingServiceParallelRequests(value);
  };

  return (
    <label>
      Number of Tagging Requests in Parallel
      <select value={uiStore.taggingServiceParallelRequests} onChange={handleChange}>
        {[...Array(UiStore.MAX_TAGGING_SERVICE_PARALLEL_REQUESTS)].map((_, i) => (
          <option key={i + 1} value={i + 1}>
            {i + 1}
          </option>
        ))}
      </select>
    </label>
  );
});
