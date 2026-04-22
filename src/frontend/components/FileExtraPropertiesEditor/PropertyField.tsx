import React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { debounce } from 'common/timeout';
import { IAction } from '../../containers/types';
import { ID } from 'src/api/id';
import { ExtraPropertyType, ExtraPropertyValue } from 'src/api/extraProperty';
import { ClientExtraProperty } from '../../entities/ExtraProperty';
import { IComputedValue } from 'mobx';

// ── Shared types ─────────────────────────────────────────────────────────────

export type ExtraPropertiesCounter = IComputedValue<
  Map<ClientExtraProperty, [number, ExtraPropertyValue | undefined]>
>;

// ── State machine ────────────────────────────────────────────────────────────

const enum Flag {
  EnableEditing,
  DisableEditing,
}

type Action = IAction<Flag.EnableEditing, ID> | IAction<Flag.DisableEditing, undefined>;

export const Factory = {
  enableEditing: (data: ID): Action => ({
    flag: Flag.EnableEditing,
    data,
  }),
  disableEditing: (): Action => ({
    flag: Flag.DisableEditing,
    data: undefined,
  }),
};

export type State = {
  editableNode: ID | undefined;
};

export function reducer(state: State, action: Action): State {
  switch (action.flag) {
    case Flag.EnableEditing:
      return {
        ...state,
        editableNode: action.data,
      };

    case Flag.DisableEditing:
      return {
        ...state,
        editableNode: action.data,
      };

    default:
      return state;
  }
}

// ── typeHandlers ─────────────────────────────────────────────────────────────

type ExtraPropertyHandler<T extends ExtraPropertyValue> = {
  isValid: (val: string) => boolean;
  parse: (val: string) => T;
  format: (val?: ExtraPropertyValue) => string;
  inputType: string;
  shouldUpdate: (val: T) => boolean;
  getKeyDownHandler?: (context: {
    extraProperty: ClientExtraProperty;
    isMultiline: boolean;
    setIsMultiline: (v: boolean) => void;
    setInputValue: (v: string) => void;
    debounceOnUpdate: (ep: ClientExtraProperty, v: ExtraPropertyValue) => void;
    inputRef: React.RefObject<HTMLInputElement>;
    cursorPos: React.MutableRefObject<number>;
    onKeyDown: (e: React.KeyboardEvent) => void;
    handler: ExtraPropertyHandler<any>;
  }) => (e: React.KeyboardEvent) => void;
};

const typeHandlers: Record<ExtraPropertyType, ExtraPropertyHandler<any>> = {
  [ExtraPropertyType.number]: {
    isValid: (val: string) => /^\d*\.?\d*$/.test(val),
    parse: (val: string) => (val === '' ? 0 : parseFloat(val)),
    format: (val) => (typeof val === 'number' ? val.toString() : ''),
    inputType: 'number',
    shouldUpdate: (val: number) => val < 100000000,
  },
  [ExtraPropertyType.text]: {
    isValid: (_: string) => true, // eslint-disable-line @typescript-eslint/no-unused-vars
    parse: (val: string) => val,
    format: (val) => (typeof val === 'string' ? val : ''),
    inputType: 'text',
    shouldUpdate: (_: string) => true, // eslint-disable-line @typescript-eslint/no-unused-vars
    getKeyDownHandler: ({
      extraProperty,
      isMultiline,
      setIsMultiline,
      setInputValue,
      debounceOnUpdate,
      inputRef,
      cursorPos,
      onKeyDown,
      handler,
    }) => {
      return (e: React.KeyboardEvent) => {
        onKeyDown(e);
        if (!isMultiline && e.key === 'Enter') {
          e.preventDefault();
          const element = inputRef.current;
          if (element && element.selectionStart && element.selectionEnd) {
            const { selectionStart, selectionEnd, value } = element;
            const newValue = value.slice(0, selectionStart) + '\n' + value.slice(selectionEnd);
            cursorPos.current = selectionStart + 1;
            setIsMultiline(true);
            setInputValue(newValue);
            debounceOnUpdate(extraProperty, handler.parse(newValue));
          }
        }
      };
    },
  },
};

// ── ExtraPropertyInput ───────────────────────────────────────────────────────

interface ExtraPropertyInputProps {
  extraProperty: ClientExtraProperty;
  value?: ExtraPropertyValue;
  onUpdate: (extraProperty: ClientExtraProperty, value: ExtraPropertyValue) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export const ExtraPropertyInput = ({
  extraProperty,
  value,
  onUpdate,
  onKeyDown,
}: ExtraPropertyInputProps) => {
  const hasLineBreak = useRef(
    (val?: ExtraPropertyValue): boolean => typeof val === 'string' && val.includes('\n'),
  ).current;
  const handler = typeHandlers[extraProperty.type];
  const [inputValue, setInputValue] = useState(handler.format(value));
  const [isMultiline, setIsMultiline] = useState(hasLineBreak(value));
  const cursorPos = useRef<number>(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setInputValue(handler.format(value));
  }, [handler, value]);

  const handleBeforeSwitch = useRef(() => {
    const active = document.activeElement;
    // check if the active element belongs to this component to avoid interference from other instances
    if (active === inputRef.current || active === textareaRef.current) {
      const el = active as HTMLInputElement | HTMLTextAreaElement;
      if (el.selectionStart != null) {
        cursorPos.current = el.selectionStart;
      }
    }
  }).current;

  //auto switch between input/textarea and update textarea height
  useEffect(() => {
    if (inputRef.current) {
      const input = inputRef.current;
      if (
        extraProperty.type !== ExtraPropertyType.number &&
        (hasLineBreak(inputValue) || input.scrollWidth > input.clientWidth)
      ) {
        handleBeforeSwitch();
        setIsMultiline(true);
      }
    } else if (textareaRef.current) {
      textareaRef.current.rows = 1; // Reset rows to measure properly
      const lineHeightStr = getComputedStyle(textareaRef.current).lineHeight;
      const lineHeight = parseFloat(lineHeightStr);
      if (lineHeight && !isNaN(lineHeight)) {
        const currentRows = Math.floor(textareaRef.current.scrollHeight / lineHeight);
        if (currentRows > 1) {
          textareaRef.current.rows = Math.min(currentRows, 15);
        } else {
          handleBeforeSwitch();
          setIsMultiline(false);
        }
      }
    }
  }, [extraProperty.type, handleBeforeSwitch, hasLineBreak, inputValue, isMultiline]);

  // Autofocus when swtiching input/textarea
  useEffect(() => {
    const element = isMultiline ? textareaRef.current : inputRef.current;
    if (element) {
      if (cursorPos.current > -1) {
        element.focus();
        element.setSelectionRange(cursorPos.current, cursorPos.current);
        cursorPos.current = -1;
      }
    }
  }, [isMultiline]);

  const debounceOnUpdate = useMemo(() => debounce(onUpdate, 500), [onUpdate]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<any>) => {
      const val = e.target.value;
      if (!handler.isValid(val)) {
        return;
      }
      const parsed = handler.parse(val);
      if (handler.shouldUpdate(parsed)) {
        setInputValue(val);
        debounceOnUpdate(extraProperty, parsed);
      }
    },
    [debounceOnUpdate, extraProperty, handler],
  );

  const handleKeyDown = useMemo(
    () =>
      handler.getKeyDownHandler?.({
        extraProperty,
        isMultiline,
        setIsMultiline,
        setInputValue,
        debounceOnUpdate,
        inputRef,
        cursorPos,
        onKeyDown,
        handler,
      }) ?? onKeyDown,
    [debounceOnUpdate, extraProperty, handler, isMultiline, onKeyDown],
  );

  return isMultiline ? (
    <textarea
      ref={textareaRef}
      value={inputValue}
      onChange={(e) => handleChange({ ...e, target: { ...e.target, value: e.target.value } })}
      onKeyDown={handleKeyDown}
      className="input"
      rows={2}
      //data-tooltip={inputValue}
    />
  ) : (
    <input
      ref={inputRef}
      type={handler.inputType}
      value={inputValue}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      className="input"
      data-tooltip={inputValue}
    />
  );
};

// ── Label ────────────────────────────────────────────────────────────────────

interface ILabelProps {
  text: string;
  setText: (value: string) => void;
  isEditing: boolean;
  onSubmit: (target: EventTarget & HTMLInputElement) => void;
  tooltip?: string;
}

export const Label = (props: ILabelProps) => {
  const divRef = useRef<HTMLDivElement | null>(null);
  const [inputWidth, setInputWidth] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!props.isEditing && divRef.current) {
      const width = divRef.current.offsetWidth;
      setInputWidth(width);
    }
  }, [props.isEditing]);

  return props.isEditing ? (
    <input
      className="input"
      autoFocus
      type="text"
      defaultValue={props.text}
      style={{
        width: inputWidth ? `calc(${inputWidth}px + 1ch)` : undefined,
      }}
      onBlur={(e) => {
        const value = e.currentTarget.value.trim();
        if (value.length > 0) {
          props.setText(value);
        }
        props.onSubmit(e.currentTarget);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        const value = e.currentTarget.value.trim();
        if (e.key === 'Enter' && value.length > 0) {
          props.setText(value);
          props.onSubmit(e.currentTarget);
        } else if (e.key === 'Escape') {
          props.onSubmit(e.currentTarget); // cancel with escape
        }
      }}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
    />
  ) : (
    <div ref={divRef} className="extra-property-label" data-tooltip={props.tooltip}>
      {props.text}
    </div>
  );
};
