export interface IHotkeyMap {
  // Outliner actions
  toggleOutliner: string;
  replaceQuery: string;

  // Inspector actions
  toggleInspector: string;
  toggleSettings: string;
  toggleHelpCenter: string;

  // Toolbar actions (these should only be active when the content area is focused)
  deleteSelection: string;
  selectAll: string;
  deselectAll: string;
  viewList: string;
  viewGrid: string;
  viewMasonryVertical: string;
  viewMasonryHorizontal: string;
  viewSlide: string;
  search: string;
  advancedSearch: string;
  refreshSearch: string;
  refreshLocationsAndDetectFileChanges: string;
  openFileTagsEditor: string;
  toggleExtraPropertiesEditor: string;
  toggleEditTagProperties: string;

  // Other
  openPreviewWindow: string;
  openExternal: string;
}

// https://blueprintjs.com/docs/#core/components/hotkeys.dialog
export const defaultHotkeyMap: IHotkeyMap = {
  toggleOutliner: '1',
  toggleInspector: '2',
  openFileTagsEditor: '3',
  toggleExtraPropertiesEditor: '4',
  toggleEditTagProperties: '5',
  replaceQuery: 'q',
  toggleSettings: 's',
  toggleHelpCenter: 'h',
  deleteSelection: 'del',
  selectAll: 'mod + a',
  deselectAll: 'mod + d',
  viewSlide: 'enter', // TODO: backspace and escape are hardcoded hotkeys to exist slide mode
  viewList: 'alt + 1',
  viewGrid: 'alt + 2',
  viewMasonryVertical: 'alt + 3',
  viewMasonryHorizontal: 'alt + 4',
  search: 'mod + f',
  advancedSearch: 'mod + shift + f',
  refreshSearch: 'r',
  refreshLocationsAndDetectFileChanges: 'l',
  openPreviewWindow: 'space',
  openExternal: 'mod + enter',
};
