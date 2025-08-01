import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type SplitAxis = 'horizontal' | 'vertical';
export type SplitAlignment = 'left' | 'right' | 'top' | 'bottom';

interface ISplit {
  id?: string;
  className?: string;
  primary: React.ReactElement;
  secondary: React.ReactElement;
  axis: SplitAxis;
  align: SplitAlignment;
  splitPoint: number;
  // API-wise it would be better to provide a callback function but we keep track
  // of the panel states already.
  isExpanded: boolean;
  onMove: (splitPoint: number, dimension: number) => void;
}

export const Split = ({
  id,
  className,
  primary,
  secondary,
  axis,
  align,
  splitPoint,
  isExpanded,
  onMove,
}: ISplit) => {
  const container = useRef<HTMLDivElement>(null);
  const origin = useRef(0);
  const isDragging = useRef(false);
  const value = useRef(splitPoint);
  const [dimension, setDimension] = useState(0);
  const resizeObserver = useRef(
    new ResizeObserver((entries) => {
      const {
        contentRect: { width, height },
      } = entries[0];
      if (axis === 'vertical') {
        setDimension(width);
      } else {
        setDimension(height);
      }
    }),
  );

  const handleMouseDown = useRef(() => {
    if (container.current !== null) {
      const rect = container.current.getBoundingClientRect();
      if (axis === 'vertical') {
        origin.current = rect.left;
        container.current.style.cursor = 'w-resize';
      } else {
        origin.current = rect.top;
        container.current.style.cursor = 's-resize';
      }
      isDragging.current = true;
      (container.current.children[1] as HTMLElement).classList.add('active');
    }
  });

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging.current) {
        return;
      }

      if (axis === 'vertical') {
        onMove(e.clientX - origin.current, e.currentTarget.clientWidth);
      } else {
        onMove(e.clientY - origin.current, e.currentTarget.clientHeight);
      }
    },
    [onMove, axis],
  );

  useLayoutEffect(() => {
    if (isExpanded) {
      value.current = splitPoint;
      container.current?.style.setProperty(`--${id}-primary-size`, `${splitPoint}px`);
    } else {
      value.current = 0;
      container.current?.style.setProperty(`--${id}-primary-size`, `${0}px`);
    }
    if (container.current !== null) {
      // Content
      (container.current.firstElementChild as HTMLElement).style.flexBasis = `${value.current}px`;
      // Splitter
      (container.current.children[1] as HTMLElement).style[align] = `${value.current}px`;
    }
  }, [align, id, isExpanded, splitPoint]);

  useEffect(() => {
    const observer = resizeObserver.current;
    const handleMouseUp = () => {
      isDragging.current = false;
      if (container.current !== null) {
        container.current.style.cursor = '';
        (container.current.children[1] as HTMLElement).classList.remove('active');
      }
    };

    // Workaround for popup windows
    let body: HTMLElement | null = null;
    if (container.current !== null) {
      body = container.current.closest('body') as HTMLElement;
      body.addEventListener('mouseup', handleMouseUp);
      resizeObserver.current.observe(container.current);
    }
    return () => {
      observer.disconnect();
      body?.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  return (
    <div ref={container} id={id} className={`split ${className}`} onMouseMove={handleMouseMove}>
      {primary}
      <div
        role="separator"
        aria-valuenow={Math.trunc((value.current / dimension) * 100)}
        aria-orientation={axis}
        onMouseDown={handleMouseDown.current}
      />
      {secondary}
    </div>
  );
};
