import { WINDOW_STORAGE_KEY } from 'common/window';
import { shell } from 'electron';
import { observer } from 'mobx-react-lite';
import React, { useEffect, useState } from 'react';
import useCustomTheme from 'src/frontend/hooks/useCustomTheme';
import { RendererMessenger } from 'src/ipc/renderer';
import { Button, IconSet, Radio, RadioGroup, Toggle } from 'widgets';
import { useStore } from '../../contexts/StoreContext';
import { InheritedTagsVisibilityModeType } from 'src/frontend/stores/UiStore';
import { Slider } from 'widgets/slider';

const fullResThresholdOptions = [
  { value: 0, label: 'Disabled' },
  { value: 640 },
  { value: 1280, label: '720p' },
  { value: 1920, label: '1080p' },
  { value: 2560, label: '2K' },
  { value: 3200 },
  { value: 3840, label: '4K' },
  { value: 4480 },
  { value: 5120 },
  { value: 5760 },
  { value: 6400 },
  { value: 7040 },
  { value: 7680, label: '8K' },
  { value: 8320 },
];

const markdownZoomFactorOptions = [
  { value: 0.2, label: '20%' },
  { value: 0.25 },
  { value: 0.3 },
  { value: 0.4 },
  { value: 0.5, label: '50% (Tiny)' },
  { value: 0.6 },
  { value: 0.7 },
  { value: 0.8, label: '80% (Compact)' },
  { value: 0.85 },
  { value: 0.9 },
  { value: 0.95 },
  { value: 1.0, label: '100% (Default)' },
  { value: 1.05 },
  { value: 1.1 },
  { value: 1.15 },
  { value: 1.2, label: '120% (Large)' },
  { value: 1.3 },
  { value: 1.4 },
  { value: 1.5, label: '150% (Huge)' },
  { value: 1.6 },
  { value: 1.7 },
  { value: 1.8 },
  { value: 1.9 },
  { value: 2.0, label: '200%' },
];

export const Appearance = observer(() => {
  const { uiStore } = useStore();

  const toggleFullScreen = (value: boolean) => {
    localStorage.setItem(WINDOW_STORAGE_KEY, JSON.stringify({ isFullScreen: value }));
    RendererMessenger.setFullScreen(value);
  };

  return (
    <>
      <h3>Theme</h3>

      <div className="vstack">
        <RadioGroup
          orientation="horizontal"
          name="Color Scheme"
          value={uiStore.theme}
          onChange={uiStore.setTheme}
        >
          <Radio value="light">Light</Radio>
          <Radio value="dark">Dark</Radio>
        </RadioGroup>
        <CustomThemePicker />
        <RadioGroup
          orientation="horizontal"
          name="Scrollbar Style"
          value={uiStore.scrollbarsStyle}
          onChange={uiStore.setScrollbarsStyle}
        >
          <Radio value="classic">Classic</Radio>
          <Radio value="hover">Hover</Radio>
        </RadioGroup>
        <Toggle
          checked={uiStore.showTreeConnectorLines}
          onChange={uiStore.toggleShowTreeConnectorLines}
        >
          Show Hierarchy Connector Lines
        </Toggle>
      </div>

      <h3>Display</h3>

      <div className="vstack">
        <Toggle checked={uiStore.isFullScreen} onChange={toggleFullScreen}>
          Show full screen
        </Toggle>
        <Zoom />
        <RadioGroup
          orientation="horizontal"
          name="Scale images..."
          value={uiStore.upscaleMode}
          onChange={uiStore.setUpscaleMode}
        >
          <Radio value="smooth">Smooth</Radio>
          <Radio value="pixelated">Pixelated</Radio>
        </RadioGroup>
      </div>

      <h3>Toolbar Buttons</h3>

      <div className="vstack">
        <Toggle
          checked={uiStore.toolbarButtonsVisibility['fileTags']}
          onChange={() => {
            uiStore.toggleToolbarButtonVisibility('fileTags');
          }}
        >
          Show File Tags Editor Button
        </Toggle>
        <Toggle
          checked={uiStore.toolbarButtonsVisibility['extraProperties']}
          onChange={() => {
            uiStore.toggleToolbarButtonVisibility('extraProperties');
          }}
        >
          Show File Extra Properties Editor Button
        </Toggle>
        <Toggle
          checked={uiStore.toolbarButtonsVisibility['info']}
          onChange={() => {
            uiStore.toggleToolbarButtonVisibility('info');
          }}
        >
          Show File Info Viewer Button
        </Toggle>
        <Toggle
          checked={uiStore.toolbarButtonsVisibility['overviewInspector']}
          onChange={() => {
            uiStore.toggleToolbarButtonVisibility('overviewInspector');
          }}
        >
          Show Inspector Button in Overview Mode
        </Toggle>
        <Toggle
          checked={uiStore.toolbarButtonsVisibility['slideInspector']}
          onChange={() => {
            uiStore.toggleToolbarButtonVisibility('slideInspector');
          }}
        >
          Show Inspector Button in Slide Mode
        </Toggle>
      </div>

      <h3>Thumbnail</h3>

      <div className="vstack">
        <Toggle
          checked={uiStore.isThumbnailFilenameOverlayEnabled}
          onChange={uiStore.toggleThumbnailFilenameOverlay}
        >
          Show filename
        </Toggle>
        <Toggle
          checked={uiStore.isThumbnailResolutionOverlayEnabled}
          onChange={uiStore.toggleThumbnailResolutionOverlay}
        >
          Show resolution
        </Toggle>
        <RadioGroup
          orientation="horizontal"
          name="Show tags"
          value={uiStore.thumbnailTagOverlayMode}
          onChange={uiStore.setThumbnailTagOverlayMode}
        >
          <Radio value="all">All</Radio>
          <Radio value="selected">Selected</Radio>
          <Radio value="disabled">Disabled</Radio>
        </RadioGroup>
        <RadioGroup
          orientation="horizontal"
          name="Shape"
          value={uiStore.thumbnailShape}
          onChange={uiStore.setThumbnailShape}
        >
          <Radio value="square">Square</Radio>
          <Radio value="letterbox">Letterbox</Radio>
        </RadioGroup>
        <Slider
          value={uiStore.largeThumbFullResThreshold}
          label="Max resolution threshold for showing the full-res image in large thumbnails"
          onChange={uiStore.setLargeThumbFullResThreshold}
          id="full-res-threshold"
          options={fullResThresholdOptions}
          min={fullResThresholdOptions[0].value}
          max={fullResThresholdOptions[fullResThresholdOptions.length - 1].value}
          step={20}
        />
      </div>

      <h3>File Tags</h3>

      <div className="vstack">
        <RadioGroup
          orientation="vertical"
          name="Inherited Tags Visibility"
          value={uiStore.inheritedTagsVisibilityMode}
          onChange={uiStore.setInheritedTagsVisibilityMode}
        >
          <Radio value={'all' as InheritedTagsVisibilityModeType}>Show All</Radio>
          <Radio
            value={'visible-when-inherited' as InheritedTagsVisibilityModeType}
            tooltip="Configure a tag's visibility when inherited by right-clicking the tag"
          >
            Show &quot;Visible When Inherited&quot; tags
          </Radio>
          <Radio value={'disabled' as InheritedTagsVisibilityModeType}>
            Do Not Show Inherited Tags
          </Radio>
        </RadioGroup>
      </div>

      <h3>Gallery Video Playback</h3>

      <div className="vstack">
        <RadioGroup
          orientation="horizontal"
          name="Playback Mode"
          value={uiStore.galleryVideoPlaybackMode}
          onChange={uiStore.setGalleryVideoPlaybackMode}
        >
          <Radio value="auto">Auto</Radio>
          <Radio value="hover">Hover</Radio>
          <Radio value="disabled">Disabled</Radio>
        </RadioGroup>
      </div>

      <h3>Descriptions and Markdown</h3>

      <div className="vstack">
        <Slider
          value={uiStore.markdownFieldZoomFactor}
          label="Markdown Zoom Factor in Fields"
          onChange={uiStore.setMarkdownFieldZoomFactor}
          id="markdown-field-zoom-factor"
          options={markdownZoomFactorOptions}
          min={markdownZoomFactorOptions[0].value}
          max={markdownZoomFactorOptions[markdownZoomFactorOptions.length - 1].value}
          step={0.05}
        />
        <Slider
          value={uiStore.markdownDialogZoomFactor}
          label="Markdown Zoom Factor in Dialogs"
          onChange={uiStore.setMarkdownDialogZoomFactor}
          id="markdown-dialog-zoom-factor"
          options={markdownZoomFactorOptions}
          min={markdownZoomFactorOptions[0].value}
          max={markdownZoomFactorOptions[markdownZoomFactorOptions.length - 1].value}
          step={0.05}
        />
        <Slider
          value={uiStore.markdownTooltipZoomFactor}
          label="Markdown Zoom Factor in Tooltips"
          onChange={uiStore.setMarkdownTooltipZoomFactor}
          id="markdown-tooltip-zoom-factor"
          options={markdownZoomFactorOptions}
          min={markdownZoomFactorOptions[0].value}
          max={markdownZoomFactorOptions[markdownZoomFactorOptions.length - 1].value}
          step={0.05}
        />
      </div>
    </>
  );
});

const Zoom = () => {
  const [localZoomFactor, setLocalZoomFactor] = useState(RendererMessenger.getZoomFactor);
  const { uiStore } = useStore();

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = Number(event.target.value);
    setLocalZoomFactor(value);
    uiStore.setZoomFactor(value);
  };

  return (
    <label>
      Zoom
      <select value={localZoomFactor} onChange={handleChange}>
        <option value={0.5}>50%</option>
        <option value={0.6}>60%</option>
        <option value={0.7}>70%</option>
        <option value={0.8}>80%</option>
        <option value={0.9}>90%</option>
        <option value={1.0}>100%</option>
        <option value={1.1}>110%</option>
        <option value={1.2}>120%</option>
        <option value={1.3}>130%</option>
        <option value={1.4}>140%</option>
        <option value={1.5}>150%</option>
        <option value={1.6}>160%</option>
        <option value={1.7}>170%</option>
        <option value={1.8}>180%</option>
        <option value={1.9}>190%</option>
        <option value={2.0}>200%</option>
      </select>
    </label>
  );
};

const CustomThemePicker = () => {
  const { theme, setTheme, refresh, options, themeDir } = useCustomTheme();

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="hstack">
      <label>
        Custom Theme
        <select onChange={(e) => setTheme(e.target.value)} defaultValue={theme}>
          {<option value="">None</option>}
          {options.map((file) => (
            <option key={file} value={file}>
              {file.replace('.css', '')}
            </option>
          ))}
        </select>
      </label>
      <Button
        icon={IconSet.FOLDER_CLOSE}
        text="Add..."
        onClick={() => shell.openExternal(themeDir)}
        tooltip="Open the directory containing the theme files"
      />
      <Button
        icon={IconSet.RELOAD}
        text="Refresh"
        onClick={refresh}
        tooltip="Reload the list of themes and current theme"
      />
    </div>
  );
};
