/**
 * Keeping what you were typing.
 *
 * Rendering here replaces the whole tree (`root.innerHTML = …`), which is fine
 * for read-only screens and quietly destructive for forms: any re-render mid-
 * typing throws the input away. And re-renders are not rare — a device
 * snapshot, a scale connecting, the websocket reconnecting when the app comes
 * back from the background. Backgrounding the app and returning to it cleared
 * a half-filled bag, and the same bug ate text in Settings.
 *
 * Two earlier fixes mirrored single fields into state by hand (the two
 * rebuttal textareas). That does not scale to every input in the skin, so this
 * generalises it: before a render, remember every control the user has
 * actually touched; after it, put those values back.
 *
 * "Actually touched" is the whole trick. A control is restored only when it
 * differs from the value the markup rendered — `defaultValue` for text,
 * `defaultChecked` for boxes, the `selected` option for menus. So a field the
 * user never typed in keeps whatever the new render says (a bean renamed
 * elsewhere still updates on screen), while a field they were editing keeps
 * their edit.
 */

/** The parts of a form control this module needs. Structural, so it is testable. */
export interface ControlLike {
  name: string;
  type: string;
  value: string;
  defaultValue: string;
  checked: boolean;
  defaultChecked: boolean;
}

export interface DirtyValue {
  form: string;
  name: string;
  value: string;
  checked: boolean;
}

/**
 * Scroll containers worth restoring, in the order they are matched.
 *
 * `.app` is the page scroller on every screen but Brew; the rest are the inner
 * lists that scroll independently. Keyed by selector plus position, which is
 * stable across a re-render in a way a node reference is not.
 */
const SCROLLERS = ['.app', '.list', '.shot-list', '.advice-body', '.screen'] as const;

export interface ScrollMemo {
  key: string;
  top: number;
  left: number;
}

export interface FocusMemo {
  form: string;
  name: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

const isToggle = (type: string): boolean => type === 'checkbox' || type === 'radio';

/** Whether the user has changed this control away from what was rendered. */
export function isDirty(control: ControlLike): boolean {
  if (!control.name) return false;
  if (isToggle(control.type)) return control.checked !== control.defaultChecked;
  return control.value !== control.defaultValue;
}

/**
 * A stable identity for a form across renders.
 *
 * Every form in the skin carries `data-action`, and the ones that repeat per
 * record also carry `data-id`; together those survive re-rendering, where a
 * DOM node reference or a position index would not.
 */
export function formKey(action: string | undefined, id: string | undefined, index: number): string {
  if (!action) return `form:${index}`;
  return id ? `${action}:${id}` : action;
}

// ---------------------------------------------------------------------------
// DOM glue
// ---------------------------------------------------------------------------

type AnyControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const CONTROL_SELECTOR = 'input[name], textarea[name], select[name]';

/**
 * A `<select>` has no `defaultValue`, so its rendered choice is read from the
 * option carrying the `selected` attribute — that is what "unchanged" means
 * for a menu.
 */
function asControlLike(el: AnyControl): ControlLike {
  if (el instanceof HTMLSelectElement) {
    const rendered = Array.prototype.find.call(
      el.options,
      (option: HTMLOptionElement) => option.defaultSelected
    ) as HTMLOptionElement | undefined;
    return {
      name: el.name,
      type: 'select',
      value: el.value,
      defaultValue: rendered?.value ?? '',
      checked: false,
      defaultChecked: false
    };
  }

  const input = el as HTMLInputElement;
  return {
    name: input.name,
    type: input.type,
    value: input.value,
    defaultValue: input.defaultValue,
    checked: Boolean(input.checked),
    defaultChecked: Boolean(input.defaultChecked)
  };
}

function keyOf(form: HTMLFormElement, index: number): string {
  return formKey(form.dataset['action'], form.dataset['id'], index);
}

/**
 * Snapshot everything the user has typed, plus where the caret is.
 *
 * `skip` names forms that were just submitted successfully: their inputs are
 * meant to come back empty, and restoring them would make an added bag look
 * like it failed to clear.
 */
/** Where every scroll container is, so a re-render can put it back. */
export function captureScroll(root: ParentNode): ScrollMemo[] {
  const memos: ScrollMemo[] = [];
  for (const selector of SCROLLERS) {
    const found = root.querySelectorAll(selector);
    for (let index = 0; index < found.length; index += 1) {
      const el = found[index] as HTMLElement;
      if (el.scrollTop === 0 && el.scrollLeft === 0) continue;
      memos.push({ key: `${selector}#${index}`, top: el.scrollTop, left: el.scrollLeft });
    }
  }
  return memos;
}

export function restoreScroll(root: ParentNode, memos: readonly ScrollMemo[]): void {
  for (const memo of memos) {
    const [selector, index] = memo.key.split('#');
    const el = root.querySelectorAll(selector!)[Number(index)] as HTMLElement | undefined;
    if (!el) continue;
    el.scrollTop = memo.top;
    el.scrollLeft = memo.left;
  }
}

export function captureForms(
  root: ParentNode,
  doc: Document,
  skip: ReadonlySet<string> = new Set()
): { dirty: DirtyValue[]; focus: FocusMemo | null } {
  const dirty: DirtyValue[] = [];
  let focus: FocusMemo | null = null;
  const active = doc.activeElement;

  const forms = root.querySelectorAll('form');
  for (let index = 0; index < forms.length; index += 1) {
    const form = forms[index] as HTMLFormElement;
    const key = keyOf(form, index);
    const controls = form.querySelectorAll(CONTROL_SELECTOR);

    for (let i = 0; i < controls.length; i += 1) {
      const el = controls[i] as AnyControl;
      if (el.dataset['noRestore'] !== undefined) continue;

      if (el === active) {
        const text = el as HTMLInputElement;
        // selectionStart throws on input types that have no selection (date,
        // number in some engines), so it is read defensively.
        let start: number | null = null;
        let end: number | null = null;
        try {
          start = text.selectionStart;
          end = text.selectionEnd;
        } catch {
          start = null;
          end = null;
        }
        focus = { form: key, name: el.name, selectionStart: start, selectionEnd: end };
      }

      if (skip.has(key)) continue;

      const control = asControlLike(el);
      if (isDirty(control)) {
        dirty.push({ form: key, name: control.name, value: control.value, checked: control.checked });
      }
    }
  }

  return { dirty, focus };
}

/**
 * Put the typed values back, and the caret with them.
 *
 * Focus is only restored when the document still has it: returning from the
 * background should not summon the keyboard on its own.
 */
export function restoreForms(
  root: ParentNode,
  doc: Document,
  snapshot: { dirty: DirtyValue[]; focus: FocusMemo | null }
): void {
  if (snapshot.dirty.length === 0 && snapshot.focus === null) return;

  const byKey = new Map<string, HTMLFormElement>();
  const forms = root.querySelectorAll('form');
  for (let index = 0; index < forms.length; index += 1) {
    const form = forms[index] as HTMLFormElement;
    byKey.set(keyOf(form, index), form);
  }

  const find = (key: string, name: string): AnyControl | null => {
    const form = byKey.get(key);
    if (!form) return null;
    return form.querySelector<AnyControl>(`[name="${CSS.escape(name)}"]`);
  };

  for (const field of snapshot.dirty) {
    const el = find(field.form, field.name);
    if (!el) continue;
    if (el instanceof HTMLInputElement && isToggle(el.type)) el.checked = field.checked;
    else el.value = field.value;
  }

  const memo = snapshot.focus;
  if (!memo || !doc.hasFocus()) return;

  const el = find(memo.form, memo.name);
  if (!el) return;
  el.focus({ preventScroll: true });
  if (memo.selectionStart === null || memo.selectionEnd === null) return;
  try {
    (el as HTMLInputElement).setSelectionRange(memo.selectionStart, memo.selectionEnd);
  } catch {
    // Not a control that carries a selection; focus alone is enough.
  }
}
