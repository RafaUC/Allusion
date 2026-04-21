import path from 'path';
import fse from 'fs-extra';
import { app } from 'electron';

// TODO: change this when running in portable mode, see portable-improvements branch
const basePath = app.getPath('userData');

export const preferencesFilePath = path.join(basePath, 'preferences.json');

export type PreferencesFile = {
  checkForUpdatesOnStartup?: boolean;
};

export let preferences: PreferencesFile = {};

export const updatePreferences = (prefs: PreferencesFile) => {
  preferences = prefs;
  fse.writeJSONSync(preferencesFilePath, prefs);
};

export function loadPreferences(): void {
  try {
    if (!fse.pathExistsSync(basePath)) {
      fse.mkdirSync(basePath);
    }
    try {
      preferences = fse.readJSONSync(preferencesFilePath);
    } catch (e) {
      // Auto update enabled by default
      preferences = { checkForUpdatesOnStartup: true };
    }
  } catch (e) {
    console.error(e);
  }
}
