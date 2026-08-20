import React, { useState, useRef, useEffect } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { IconSet } from 'widgets/icons';

interface MarkdownTextAreaProps {
  id?: string;
  value: string;
  onSave: (newValue: string) => void;
  placeholder?: string;
  rows?: number;
}

export const MarkdownTextArea: React.FC<MarkdownTextAreaProps> = ({
  id,
  value,
  onSave,
  placeholder = 'Double click to edit...',
  rows = 4,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [currentValue, setCurrentValue] = useState(value);

  const [width, setWidth] = useState<number | null>(null);
  const [height, setHeight] = useState<number | null>(() => {
    if (!id) {
      return null;
    }
    const savedHeight = localStorage.getItem(`md-area-height:${id}`);
    return savedHeight ? parseFloat(savedHeight) : null;
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
    if (!isEditing || !textareaRef.current || !id) {
      return;
    }

    const textarea = textareaRef.current;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const newHeight = entry.contentRect.height;
        if (newHeight > 0) {
          localStorage.setItem(`md-area-height:${id}`, newHeight.toString());
        }
      }
    });

    resizeObserver.observe(textarea);
    return () => resizeObserver.disconnect();
  }, [isEditing, id]);

  const handleStartEditing = () => {
    if (!height && containerRef.current) {
      const currentWidth = containerRef.current.getBoundingClientRect().width;
      const currentHeight = containerRef.current.getBoundingClientRect().height;
      setWidth(currentWidth);
      setHeight(currentHeight);
    }
    setIsEditing(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      handleBlur();
    }
    if (e.key === 'Escape') {
      setCurrentValue(value);
      setIsEditing(false);
    }
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
        onChange={(e) => setCurrentValue(e.target.value)}
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
    >
      <div className="content-wrapper">
        {value.trim() ? (
          <div className="markdown-container">
            <MarkdownRenderer content={value} />
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
