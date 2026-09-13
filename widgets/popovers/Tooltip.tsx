import { VirtualElement, autoPlacement, offset, shift, size } from '@floating-ui/core';
import { useFloating } from '@floating-ui/react-dom';
import { IS_DEV } from 'common/process';
import { Observer } from 'mobx-react-lite';
import React, { useEffect, useRef, useState } from 'react';
import { MarkdownRenderer } from 'src/frontend/components/MarkdownRenderer';
import { TEST_MARKDOWN_TEXT } from 'src/frontend/components/MarkdownTest';
import { useStore } from 'src/frontend/contexts/StoreContext';
import { TooltipType } from 'widgets/utility';

const DEBUG_TOOLTIP_AT_CURSOR = (false as boolean) && IS_DEV;

export const TooltipLayer = ({ document }: { document: Document }) => {
  const virtualElement = useRef<VirtualElement>({
    getBoundingClientRect: () => new DOMRect(),
    contextElement: null,
  });
  const { x, y, reference, floating, strategy, update, refs } = useFloating({
    middleware: [
      offset({ mainAxis: 4, crossAxis: 4 }),
      size({
        apply({ availableWidth, availableHeight, elements }) {
          elements.floating.style.maxHeight = `max(49vh, ${Math.max(0, availableHeight - 4)}px)`;
          elements.floating.style.maxWidth = `max(49vw, ${Math.max(0, availableWidth - 4)}px)`;
        },
      }),
      autoPlacement(),
      shift({ boundary: document.body, crossAxis: true, padding: 4 }),
    ],
  });
  const { uiStore } = useStore();
  const [isOpen, setIsOpen] = useState(false);
  const isOpenRef = useRef(isOpen);
  const content = useRef<string>('');
  const tooltipType = useRef<TooltipType | undefined>('text');
  const timerID = useRef<number>();
  const graceID = useRef<number>();
  isOpenRef.current = isOpen;

  /* small chunk to test if an issue is an update problem
  useEffect(() => {
    const interval = setInterval(() => {
      if (isOpenRef.current) {
        update();
      }
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [update]);
  //*/

  useEffect(() => {
    reference(virtualElement.current);

    if (DEBUG_TOOLTIP_AT_CURSOR) {
      content.current = TEST_MARKDOWN_TEXT;
      tooltipType.current = 'markdown';
      return registerCursorTooltipDebug({
        document,
        virtualElement,
        open: () => setIsOpen(true),
        update,
      });
    }

    const handleShow = (e: MouseEvent | FocusEvent): HTMLElement | undefined => {
      const target = (e.target as HTMLElement).closest('[data-tooltip]') as any;
      const isInsideNormalMarkdown =
        refs.floating.current?.contains(e.target as Node) &&
        (e.target as HTMLElement).closest('.markdown-container') &&
        !(e.target as HTMLElement).closest('.markdown-minimal'); // check if not contains .markdown-minimal
      if (isInsideNormalMarkdown) {
        window.clearTimeout(graceID.current);
        graceID.current = undefined;
        window.clearTimeout(timerID.current);
        timerID.current = undefined;
        return;
      }
      if (target == null || !('dataset' in target) || !(target.dataset as any)['tooltip']) {
        return;
      }
      content.current = target.dataset['tooltip'];
      tooltipType.current = target.dataset['tooltipType'] as TooltipType;
      if (virtualElement.current.contextElement !== target) {
        window.clearTimeout(timerID.current);
        timerID.current = window.setTimeout(() => {
          timerID.current = undefined;
          window.clearTimeout(graceID.current);
          graceID.current = undefined;
          setIsOpen(true);
          requestAnimationFrame(() => {
            update();
            requestAnimationFrame(update);
          });
        }, 500);
      }
      const boundingRect = target.getBoundingClientRect();
      virtualElement.current.getBoundingClientRect = () => boundingRect;
      virtualElement.current.contextElement = target;
    };

    const handleHide = (e: MouseEvent | FocusEvent) => {
      // add a grace period to allow moving between the tooltip and the target element without hiding it immediately
      if (
        !isOpenRef.current ||
        virtualElement.current.contextElement?.contains(e.relatedTarget as Node) ||
        (tooltipType.current === 'markdown' &&
          refs.floating.current?.contains(e.relatedTarget as Node))
      ) {
        window.clearTimeout(graceID.current);
        graceID.current = undefined;
        return;
      }
      if (graceID.current !== undefined) {
        return;
      }
      let graceTime = 10;
      if (tooltipType.current === 'markdown') {
        graceTime = 500; // longer grace period for markdown tooltips
      }
      window.clearTimeout(graceID.current);
      graceID.current = window.setTimeout(() => {
        graceID.current = undefined;
        setIsOpen(false);
        virtualElement.current.contextElement = null;
        window.clearTimeout(timerID.current);
        timerID.current = undefined;
      }, graceTime);
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        virtualElement.current.contextElement = null;
      }
    };

    document.addEventListener('mouseover', handleShow, true);
    document.addEventListener('mouseout', handleHide, true);
    document.addEventListener('focus', handleShow, true);
    document.addEventListener('blur', handleHide, true);
    document.addEventListener('keydown', handleEscape, true);
    document.addEventListener('dragstart', handleHide, true);

    return () => {
      document.removeEventListener('mouseover', handleShow, true);
      document.removeEventListener('mouseout', handleHide, true);
      document.removeEventListener('focus', handleShow, true);
      document.removeEventListener('blur', handleHide, true);
      document.removeEventListener('keydown', handleEscape, true);
      document.removeEventListener('dragstart', handleHide, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, update, reference]);

  return (
    <div
      ref={floating}
      style={{
        position: strategy,
        top: 0,
        left: 0,
        transform: `translate(${Math.round(x ?? 0.0)}px,${Math.round(y ?? 0.0)}px)`,
      }}
      role="tooltip"
      data-popover
      data-open={isOpen}
      //dangerouslySetInnerHTML={{ __html: content.current }}
    >
      {tooltipType.current?.startsWith('markdown') ? (
        <Observer>
          {() => (
            <MarkdownRenderer
              className={tooltipType.current}
              content={content.current}
              zoom={uiStore.markdownTooltipZoomFactor}
            />
          )}
        </Observer>
      ) : (
        content.current
      )}
    </div>
  );
};

type CursorTooltipDebugOptions = {
  document: Document;
  virtualElement: React.MutableRefObject<VirtualElement>;
  open: () => void;
  update: () => void;
};

function registerCursorTooltipDebug({
  document,
  virtualElement,
  open,
  update,
}: CursorTooltipDebugOptions) {
  let rafID: number | undefined;
  const showUpdate = () => {
    if (rafID !== undefined) {
      window.cancelAnimationFrame(rafID);
    }
    rafID = requestAnimationFrame(() => {
      open();
      update();
    });
  };
  const handleMouseMove = (event: MouseEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : document.body;
    const cursorRect = DOMRect.fromRect({
      x: event.clientX,
      y: event.clientY,
      width: 1,
      height: 1,
    });

    virtualElement.current.getBoundingClientRect = () => cursorRect;
    virtualElement.current.contextElement = target;
    showUpdate();
  };

  document.addEventListener('mousemove', handleMouseMove, true);
  return () => document.removeEventListener('mousemove', handleMouseMove, true);
}
