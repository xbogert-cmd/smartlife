/**
 * Tracks which DOM elements the AI is currently allowed to act on. Populated
 * by browser_list_actionable_elements, consumed by browser_click/type/select.
 *
 * Refs are globally unique (a single incrementing counter, never scoped or
 * reset per tab), so two different tabs can never produce a colliding ref,
 * and a stale ref from an EARLIER read of the SAME tab can never
 * coincidentally resolve against a LATER read's elements -- recordElements
 * always invalidates whatever the tab had before adding its new entries.
 */
export interface ElementDescriptor {
  ref: string;
  role: 'button' | 'link' | 'text' | 'checkbox' | 'radio' | 'select';
  label: string;
  /** A text field's current value, or a checkbox/radio's 'checked'/'unchecked', or a select's currently chosen option text. Null for a button or link, which have no value of their own. */
  state: string | null;
  /** Only present for role 'select' -- the visible text of every <option>, in order. */
  options: string[] | null;
}

interface StoredElement extends ElementDescriptor {
  tabId: string;
}

let nextRefNumber = 1;
const elementsByRef = new Map<string, StoredElement>();
const refsByTab = new Map<string, Set<string>>();

export function recordElements(
  tabId: string,
  elements: Array<Omit<ElementDescriptor, 'ref'>>
): ElementDescriptor[] {
  invalidateTab(tabId);
  const refs = new Set<string>();
  const described = elements.map((el): ElementDescriptor => {
    const ref = `ref_${nextRefNumber++}`;
    elementsByRef.set(ref, { ref, tabId, ...el });
    refs.add(ref);
    return { ref, ...el };
  });
  refsByTab.set(tabId, refs);
  return described;
}

export function resolveElement(ref: string): (ElementDescriptor & { tabId: string }) | null {
  return elementsByRef.get(ref) ?? null;
}

export function invalidateTab(tabId: string): void {
  const refs = refsByTab.get(tabId);
  if (refs === undefined) return;
  for (const ref of refs) elementsByRef.delete(ref);
  refsByTab.delete(tabId);
}
