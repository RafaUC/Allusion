import React, {
  useState,
  useRef,
  useEffect,
  ChangeEventHandler,
  KeyboardEventHandler,
} from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { IconSet } from 'widgets/icons';

interface MarkdownTextAreaProps {
  sizeId?: string;
  value: string;
  onSave: (newValue: string) => void;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  onChange?: ChangeEventHandler<HTMLTextAreaElement>;
  placeholder?: string;
  rows?: number;
  initialHeight?: number;
  zoom?: number;
}

export const MarkdownTextArea = ({
  sizeId,
  value,
  onSave,
  onKeyDown,
  onChange,
  placeholder = 'Double click to edit text (markdown supported)...',
  rows = 4,
  initialHeight = 50,
  zoom,
}: MarkdownTextAreaProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [currentValue, setCurrentValue] = useState(value);

  const [width, setWidth] = useState<number | null>(null);
  const [height, setHeight] = useState<number | null>(() => {
    const savedHeight = localStorage.getItem(`md-area-height:${sizeId}`);
    return savedHeight ? parseFloat(savedHeight) : initialHeight;
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCurrentValue(value);
  }, [value]);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isEditing]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const container = containerRef.current;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        let newHeight = 0;
        if (entry.borderBoxSize[0]) {
          newHeight = entry.borderBoxSize[0].blockSize;
        } else {
          newHeight = entry.target.getBoundingClientRect().height;
        }
        if (newHeight > 0) {
          localStorage.setItem(`md-area-height:${sizeId}`, newHeight.toString());
        }
      }
    });

    if (textarea) {
      resizeObserver.observe(textarea);
    }
    if (container) {
      resizeObserver.observe(container);
    }
    return () => resizeObserver.disconnect();
  }, [isEditing, sizeId]);

  const handleStartEditing = () => {
    if (!height && containerRef.current) {
      const currentWidth = containerRef.current.getBoundingClientRect().width;
      const currentHeight = containerRef.current.getBoundingClientRect().height;
      setWidth(currentWidth);
      setHeight(currentHeight);
    }
    setIsEditing(true);
  };

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.stopPropagation();
      handleBlur();
    } else if (e.key === 'Escape') {
      setCurrentValue(value);
      setIsEditing(false);
    } else {
      onKeyDown?.(e);
    }
  };

  const handleChange: ChangeEventHandler<HTMLTextAreaElement> = (e) => {
    onChange?.(e);
    setCurrentValue(e.currentTarget.value);
  };

  const handleBlur = () => {
    setIsEditing(false);
    if (currentValue !== value) {
      onSave(currentValue);
    }
  };

  const dynamicStyle = height
    ? { height: `${height}px`, width: width ? `${width}px` : undefined }
    : undefined;

  if (isEditing) {
    return (
      <textarea
        ref={textareaRef}
        rows={rows}
        className="input markdown-text-area"
        value={currentValue}
        onKeyDown={handleKeyDown}
        onChange={handleChange}
        onBlur={handleBlur}
        style={dynamicStyle}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className="interactive-markdown-container"
      onDoubleClick={handleStartEditing}
      style={dynamicStyle}
      data-tooltip="Double click to edit text (markdown supported)"
    >
      <div className="content-wrapper">
        {value.trim() ? (
          <div className="markdown-container">
            <MarkdownRenderer content={value} zoom={zoom} />
          </div>
        ) : (
          <span className="placeholder">{placeholder}</span>
        )}
      </div>

      <button onClick={handleStartEditing} className="pencil-button" title="Editar" type="button">
        {IconSet.EDIT}
      </button>
    </div>
  );
};
