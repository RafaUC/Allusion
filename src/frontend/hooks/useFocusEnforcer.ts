import { useEffect, useCallback, RefObject } from 'react';

interface FocusOptions {
  isActive: boolean;
  ref: RefObject<HTMLElement | null>; // Pasamos la ref del panel
  onFocusLost: () => void;
  whitelistSelector?: string;
}

const DATA_ATTR = 'data-focus-enforcer-zone';

const useFocusEnforcer = ({
  isActive,
  ref,
  onFocusLost,
  whitelistSelector = '[data-contextmenu="true"]',
}: FocusOptions) => {
  const checkAndRestore = useCallback(() => {
    // request animation frame to allow the DOM to update focus
    requestAnimationFrame(() => {
      const activeEl = document.activeElement;
      if (!activeEl || activeEl === document.body) {
        onFocusLost();
        return;
      }
      const isInMyPanel = ref.current?.contains(activeEl);
      const isInOtherPanel = activeEl.closest(`[${DATA_ATTR}]`);
      const isInWhitelist = whitelistSelector && activeEl.closest(whitelistSelector);

      // If not in any claimed element reclaim focus
      if (!isInMyPanel && !isInOtherPanel && !isInWhitelist) {
        ref.current?.focus();
        onFocusLost();
      }
    });
  }, [onFocusLost, whitelistSelector, ref]);

  useEffect(() => {
    if (!isActive || !ref.current) {
      return;
    }

    // Add claimed attr to know if any elemnt is claimed by another instance of the hook
    // This prevents the hook from fighting with other components for focus.
    const element = ref.current;
    element.setAttribute(DATA_ATTR, 'true');

    // Add global listeners
    document.addEventListener('click', checkAndRestore, true);
    document.addEventListener('keydown', checkAndRestore, true);

    return () => {
      // remove listener on unmount
      element.removeAttribute(DATA_ATTR);
      document.removeEventListener('click', checkAndRestore, true);
      document.removeEventListener('keydown', checkAndRestore, true);
    };
  }, [isActive, ref, checkAndRestore]);
};

export default useFocusEnforcer;
