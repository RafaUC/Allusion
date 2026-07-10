import { RefObject, useEffect, useRef } from 'react';

export interface ScopeInteractionProps {
  /** Hierarchical path (e.g., "main-menu/option-1") */
  currentPath: string;
  /** Triggered when an interaction occurs outside the currentPath branch */
  onOutside?: (event: MouseEvent | FocusEvent) => void;
  /** Triggered when an interaction occurs within the currentPath branch */
  onInside?: (event: MouseEvent | FocusEvent) => void;
  /** Optional Ref to automatically assign the data-logical-path attribute */
  elementRef?: RefObject<Element | null>;
}

export const INTERACTION_PATH_ATTRIBUTE_NAME = 'data-logical-path';
export const INTERACTION_IGNORE_ATTRIBUTE_NAME = 'data-logical-ignore';

/**
 * Hook to detect interactions (click or focus) outside of a conceptual/hierarchical element tree.
 *
 * It allows managing interaction behaviors like "blur" or others for elements that are logically related (parent/child)
 * but might be physically separated in the DOM (e.g., Portals, Floating UI).
 *
 * It uses a prefix-based path matching (e.g., "menu" matches "menu/sub-menu/item-1").
 *
 * @param currentPath - Hierarchical path (e.g., "main-menu/option-1").
 * @param onOutside - Triggered when an interaction occurs outside the currentPath branch.
 * @param onInside - Triggered when an interaction occurs within the currentPath branch.
 * @param elementRef - Optional Ref to automatically assign the data-logical-path attribute.
 */
export function useScopeInteraction({
  currentPath,
  onOutside,
  onInside,
  elementRef,
}: ScopeInteractionProps) {
  // Keep mutable properties up to date without triggering effect cleanups
  const handlers = useRef({ onOutside, onInside, currentPath });
  useEffect(() => {
    handlers.current = { onOutside, onInside, currentPath };
  }, [onOutside, onInside, currentPath]);

  // Synchronize the DOM attribute layout
  useEffect(() => {
    if (elementRef?.current) {
      elementRef.current.setAttribute(INTERACTION_PATH_ATTRIBUTE_NAME, currentPath);
    }
  }, [currentPath, elementRef]);

  // suscribe the handlers
  useEffect(() => {
    // use getters to return the current value from the ref
    const scopeRegistration: ActiveScope = {
      get currentPath() {
        return handlers.current.currentPath;
      },
      get onOutside() {
        return handlers.current.onOutside;
      },
      get onInside() {
        return handlers.current.onInside;
      },
    };

    activeScopes.add(scopeRegistration);
    attachGlobalListeners();

    return () => {
      activeScopes.delete(scopeRegistration);
      detachGlobalListeners(); // try to remove the global listener if no more scopes ares suscribed
    };
  }, []);
}

///////////////////////////////////////////////////////////////////////////////////////////////
// Global event suscription handlers, to prevent event suscription spamming and easier debug.
///////////////////////////////////////////////////////////////////////////////////////////////

interface ActiveScope {
  currentPath: string;
  onOutside?: (event: MouseEvent | FocusEvent) => void;
  onInside?: (event: MouseEvent | FocusEvent) => void;
}

/** Stores all currently mounted hook instances */
const activeScopes = new Set<ActiveScope>();

const handleGlobalInteraction = (event: MouseEvent | FocusEvent) => {
  const target = event.target as Element | undefined;
  if (!target) {
    return;
  }
  // Early exit if the target or any ancestor is explicitly marked to be ignored
  if (target.closest(`[${INTERACTION_IGNORE_ATTRIBUTE_NAME}]`)) {
    return;
  }
  // Query the DOM only ONCE per interaction event
  const interactiveEl = target.closest(`[${INTERACTION_PATH_ATTRIBUTE_NAME}]`);
  const targetPath = interactiveEl?.getAttribute(INTERACTION_PATH_ATTRIBUTE_NAME) || '';
  // Debug
  //console.log(`[ScopeInteraction] Target Path: "${targetPath}" | Event: ${event.type}`);

  // Dispatch the event status to all active hook instances
  activeScopes.forEach((scope) => {
    if (!targetPath.startsWith(scope.currentPath)) {
      //console.log('[onOutside] Target : ', target, 'CurrentPath: ', scope.currentPath, ' | Event: ', event.type); // eslint-disable-line prettier/prettier
      scope.onOutside?.(event);
    } else {
      scope.onInside?.(event);
    }
  });
};

/** Track the global listener state */
let globalListenersAttached = false;

const attachGlobalListeners = () => {
  if (!globalListenersAttached) {
    document.addEventListener('mousedown', handleGlobalInteraction);
    document.addEventListener('focusin', handleGlobalInteraction);
    globalListenersAttached = true;
  }
};

const detachGlobalListeners = () => {
  if (globalListenersAttached && activeScopes.size === 0) {
    document.removeEventListener('mousedown', handleGlobalInteraction);
    document.removeEventListener('focusin', handleGlobalInteraction);
    globalListenersAttached = false;
  }
};
