import React, { useRef } from 'react';
import { observer } from 'mobx-react-lite';
import ProgressBar from 'src/frontend/components/ProgressBar';
import { useStore } from 'src/frontend/contexts/StoreContext';

const ContentProgressBar = observer(() => {
  const { fileStore } = useStore();
  const {
    numLoadedFiles,
    fileList,
    numTotalFiles,
    numUntaggedFiles,
    showsQueryContent,
    showsMissingContent,
    showsAllContent,
    showsUntaggedContent,
    fetchTaskIdPair,
  } = fileStore;
  let total: number;

  //** logic that includes the "FilesFromBackend" progress in the total and progress */
  if (showsQueryContent || showsMissingContent) {
    if (
      fetchTaskIdPair[1] !== 0 ||
      numLoadedFiles > fileList.length ||
      (numLoadedFiles === 0 && fileList.length > 0)
    ) {
      total = numTotalFiles;
    } else {
      total = fileList.length;
    }
  } else if (showsAllContent) {
    total = numTotalFiles || fileList.length;
  } else if (showsUntaggedContent) {
    total = numUntaggedFiles || fileList.length;
  } else {
    return null;
  }
  let simulatedTotal = total / 2;
  const AverageTime = fileStore.activeAverageFetchTime * 1.05;
  const current = numLoadedFiles;

  /** This next block can be removed to show the full FilesFromBackend progress
   * Reassigning the total to a lower value makes the loading animation finish as soon
   * as there are items already loaded and ready to be displayed.
   * This simulates the average time it takes to fetch data, except in the case of showMissingImages.
   */
  if (!showsMissingContent) {
    total = Math.min(total, 1);
    // reasignin simulatedTotal to make the simulated progress take 19/20 of the bar exactly
    simulatedTotal = total ? 19 : 0;
  }

  return (
    <ProgressBar
      current={current}
      total={total}
      simulatedTotal={simulatedTotal}
      simulatedDurationMs={AverageTime}
      simulatedResetKey={fetchTaskIdPair[0]}
      height={'3px'}
    />
  );
});

export default ContentProgressBar;
