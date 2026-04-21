import type { ClientLocation } from 'src/frontend/entities/Location';

/**
 * Returns true if the watcher for this location should be restarted,
 * i.e. when the location's path has changed since the watcher was started.
 */
export function shouldRestartWatcher(
  location: ClientLocation,
  previousPath: string,
): boolean {
  return location.path !== previousPath;
}
