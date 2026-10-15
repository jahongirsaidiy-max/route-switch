import { useRef, type KeyboardEvent, type ReactElement } from 'react';

import styles from './Segment.module.css';

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SegmentProps<T extends string> {
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
  readonly onChange: (next: T) => void;
  /** Accessible name of the group (the design shows it as the field label "Turi"). */
  readonly label: string;
  readonly disabled?: boolean;
}

const KEY_STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * The option a key moves to from `value`, skipping disabled options and
 * wrapping around; `null` when the key does not move the selection.
 */
export function nextSegmentValue<T extends string>(
  options: readonly SegmentOption<T>[],
  value: T,
  key: string,
): T | null {
  const enabled = options.filter((option) => option.disabled !== true);
  if (enabled.length === 0) return null;
  let next: SegmentOption<T> | undefined;
  if (key === 'Home') next = enabled[0];
  else if (key === 'End') next = enabled[enabled.length - 1];
  else {
    const step = KEY_STEPS[key];
    if (step === undefined) return null;
    const index = enabled.findIndex((option) => option.value === value);
    const start = index === -1 ? (step > 0 ? -1 : 0) : index;
    next = enabled[(start + step + enabled.length) % enabled.length];
  }
  return next === undefined || next.value === value ? null : next.value;
}

/** The key event fields the group's key handler uses. */
export interface SegmentKeyEvent {
  readonly key: string;
  readonly preventDefault: () => void;
}

export interface SegmentKeyContext<T extends string> {
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
  readonly disabled: boolean;
  readonly onChange: (next: T) => void;
  /** Moves keyboard focus to the option's button. */
  readonly focus: (value: T) => void;
}

/**
 * The group's keydown handler: an arrow, Home or End key selects the next
 * enabled option, moves focus to it and keeps the page from scrolling. A
 * disabled group and every other key are left alone.
 */
export function handleSegmentKey<T extends string>(context: SegmentKeyContext<T>, event: SegmentKeyEvent): void {
  if (context.disabled) return;
  const next = nextSegmentValue(context.options, context.value, event.key);
  if (next === null) return;
  event.preventDefault();
  context.onChange(next);
  context.focus(next);
}

/**
 * The option that holds the group's single tab stop: the selected option if
 * it is enabled, otherwise the first enabled option; null when every option
 * is disabled.
 */
export function segmentTabStop<T extends string>(options: readonly SegmentOption<T>[], value: T): T | null {
  const enabled = options.filter((option) => option.disabled !== true);
  return (enabled.find((option) => option.value === value) ?? enabled[0])?.value ?? null;
}

/**
 * The design's segmented control (rule kind: IP / Subnet / Domen): a radio
 * group with one tab stop, moved with the arrow keys.
 */
export function Segment<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled = false,
}: SegmentProps<T>): ReactElement {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const tabStop = disabled ? null : segmentTabStop(options, value);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    handleSegmentKey(
      {
        options,
        value,
        disabled,
        onChange,
        focus: (next) => buttons.current.get(next)?.focus(),
      },
      event,
    );
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={styles['segment']}
      data-count={options.length}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const selected = option.value === value;
        const tabbable = option.value === tabStop;
        return (
          <button
            key={option.value}
            ref={(element) => {
              if (element === null) buttons.current.delete(option.value);
              else buttons.current.set(option.value, element);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={tabbable ? 0 : -1}
            disabled={disabled || option.disabled === true}
            className={styles['item']}
            data-selected={selected}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
