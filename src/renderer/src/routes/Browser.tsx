import { useState } from 'react';
import { AddressBar } from '../browser/AddressBar';
import { FindBar } from '../browser/FindBar';
import { TabStrip } from '../browser/TabStrip';
import { ViewportSlot } from '../browser/ViewportSlot';
import { useBrowser } from '../browser/useBrowser';

export function Browser(): React.JSX.Element {
  const { state, activeTab, openTab, closeTab, activateTab, navigate, goBack, goForward, reload, stop } =
    useBrowser();
  const [findOpen, setFindOpen] = useState(false);

  // h-full with no overflow: the native view is positioned from this element's
  // rectangle, and a scrolling container would move it out from under itself.
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {state !== null && (
        <TabStrip
          tabs={state.tabs}
          activeTabId={state.activeTabId}
          onActivate={(id) => void activateTab(id)}
          onClose={(id) => void closeTab(id)}
          onNewTab={() => void openTab('about:blank')}
        />
      )}

      {activeTab !== null && (
        <div className="px-2 py-1">
          <AddressBar
            tab={activeTab}
            onNavigate={(input) => void navigate(input)}
            onBack={() => void goBack()}
            onForward={() => void goForward()}
            onReload={() => void reload()}
            onStop={() => void stop()}
            onToggleFind={() => setFindOpen((open) => !open)}
          />
        </div>
      )}

      {findOpen && activeTab !== null && (
        <FindBar
          onFind={(text) => void window.smartlife.browser.find(activeTab.id, text)}
          onClose={() => {
            setFindOpen(false);
            void window.smartlife.browser.stopFind(activeTab.id);
          }}
        />
      )}

      {activeTab?.error != null ? (
        // The native view is hidden behind this, so without an explicit error
        // panel a failed load is an unexplained blank rectangle.
        <div role="alert" className="flex flex-1 flex-col items-start gap-3 p-8">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
            This page didn&apos;t load
          </h2>
          <p style={{ color: 'var(--color-text-muted)' }}>
            {activeTab.error.description} ({activeTab.error.code})
          </p>
          <button
            type="button"
            onClick={() => void reload()}
            className="rounded-md px-3 py-1.5 text-sm"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          >
            Try again
          </button>
        </div>
      ) : (
        <ViewportSlot />
      )}
    </div>
  );
}
