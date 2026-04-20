import React from 'react';
import { observer } from 'mobx-react-lite';
import { encodeFilePath } from 'common/fs';
import { useStore } from '../../contexts/StoreContext';
import { ClientFile } from '../../entities/File';

const SimilarFilesPanel = observer(() => {
  const { fileStore, uiStore } = useStore();
  const { similarFiles, similarFilesStatus } = fileStore;

  if (!fileStore.isSemanticReady) {
    return null;
  }

  const handleClick = (file: ClientFile) => {
    uiStore.selectFile(file, true);
  };

  return (
    <section>
      <header>
        <h2>Similar Images</h2>
      </header>
      {similarFilesStatus === 'loading' && (
        <div className="similar-files-loading">Loading...</div>
      )}
      {similarFilesStatus === 'error' && (
        <div className="similar-files-message">Could not load suggestions</div>
      )}
      {similarFilesStatus === 'done' && similarFiles.length === 0 && (
        <div className="similar-files-message">No similar images found</div>
      )}
      {similarFilesStatus === 'done' && similarFiles.length > 0 && (
        <div className="similar-files-grid">
          {similarFiles.map((file) => (
            <button
              key={file.id}
              className="similar-file-thumb"
              onClick={() => handleClick(file)}
              title={file.filename}
            >
              <img
                src={encodeFilePath(file.thumbnailPath)}
                alt={file.filename}
                draggable={false}
              />
            </button>
          ))}
        </div>
      )}
    </section>
  );
});

export default SimilarFilesPanel;
