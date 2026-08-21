import { describe, expect, it, vi } from 'vitest';
import { DENIED_PERMISSIONS } from './security';
import {
  BROWSER_PARTITION,
  createNavigationGuard,
  createPermissionHandlers,
  createWindowOpenHandler,
  EMBEDDED_WEB_PREFERENCES,
} from './handlers';

describe('EMBEDDED_WEB_PREFERENCES', () => {
  // The entire security model of this phase rests on this one assertion.
  // window.smartlife cannot exist in embedded content because nothing ever
  // puts it there.
  it('never sets a preload script', () => {
    expect('preload' in EMBEDDED_WEB_PREFERENCES).toBe(false);
    expect(Object.keys(EMBEDDED_WEB_PREFERENCES)).not.toContain('preload');
  });

  it('isolates context, disables node, and sandboxes', () => {
    expect(EMBEDDED_WEB_PREFERENCES.contextIsolation).toBe(true);
    expect(EMBEDDED_WEB_PREFERENCES.nodeIntegration).toBe(false);
    expect(EMBEDDED_WEB_PREFERENCES.sandbox).toBe(true);
  });

  it('never disables webSecurity', () => {
    expect('webSecurity' in EMBEDDED_WEB_PREFERENCES).toBe(false);
  });

  it('uses a non-default persistent partition', () => {
    // Not the default session: the app's CSP is bound to defaultSession and
    // would break every website loaded here.
    expect(BROWSER_PARTITION).toBe('persist:browser');
    expect(EMBEDDED_WEB_PREFERENCES.partition).toBe(BROWSER_PARTITION);
  });
});

describe('createNavigationGuard', () => {
  it('allows http and https through untouched', () => {
    const onBlocked = vi.fn();
    const guard = createNavigationGuard(onBlocked);
    const event = { preventDefault: vi.fn() };

    guard(event, 'https://uncw.edu/');

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it.each([
    'file:///etc/passwd',
    'data:text/html,<h1>hi</h1>',
    'blob:https://evil.test/1',
    'javascript:alert(1)',
    'smartlife://internal',
  ])('blocks %s and reports it', (url) => {
    const onBlocked = vi.fn();
    const guard = createNavigationGuard(onBlocked);
    const event = { preventDefault: vi.fn() };

    guard(event, url);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(onBlocked).toHaveBeenCalledWith(url);
  });

  it('still prevents navigation even if onBlocked throws', () => {
    const onBlocked = vi.fn(() => {
      throw new Error('callback error');
    });
    const guard = createNavigationGuard(onBlocked);
    const event = { preventDefault: vi.fn() };

    // Guard should not throw - it swallows callback errors
    guard(event, 'file:///etc/passwd');
    // preventDefault must be called even if onBlocked throws
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});

describe('createWindowOpenHandler', () => {
  it('always denies, even for a URL it is happy to open', () => {
    const openTab = vi.fn();
    const handler = createWindowOpenHandler(openTab, vi.fn());
    expect(handler({ url: 'https://uncw.edu/' })).toEqual({ action: 'deny' });
  });

  it('always denies for a URL it refuses', () => {
    const handler = createWindowOpenHandler(vi.fn(), vi.fn());
    expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
  });

  it('opens an allowed popup as a tab instead', () => {
    const openTab = vi.fn();
    const handler = createWindowOpenHandler(openTab, vi.fn());
    handler({ url: 'https://uncw.edu/popup' });
    expect(openTab).toHaveBeenCalledWith('https://uncw.edu/popup');
  });

  it('does not open a tab for a refused scheme, and reports it', () => {
    const openTab = vi.fn();
    const onBlocked = vi.fn();
    const handler = createWindowOpenHandler(openTab, onBlocked);
    handler({ url: 'file:///etc/passwd' });
    expect(openTab).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledWith('file:///etc/passwd');
  });

  it('still denies even if openTab throws', () => {
    const openTab = vi.fn(() => {
      throw new Error('tab open error');
    });
    const handler = createWindowOpenHandler(openTab, vi.fn());
    // Should return deny even if openTab throws
    const result = handler({ url: 'https://uncw.edu/' });
    expect(result).toEqual({ action: 'deny' });
  });

  it('still denies even if onBlocked throws', () => {
    const onBlocked = vi.fn(() => {
      throw new Error('blocked error');
    });
    const handler = createWindowOpenHandler(vi.fn(), onBlocked);
    // Should return deny even if onBlocked throws
    const result = handler({ url: 'file:///etc/passwd' });
    expect(result).toEqual({ action: 'deny' });
  });
});

describe('createPermissionHandlers', () => {
  it('denies every permission Electron can request', () => {
    const onDenied = vi.fn();
    const { requestHandler } = createPermissionHandlers(onDenied);

    for (const permission of DENIED_PERMISSIONS) {
      const callback = vi.fn();
      requestHandler({}, permission, callback);
      expect(callback).toHaveBeenCalledWith(false);
    }
    expect(onDenied).toHaveBeenCalledTimes(DENIED_PERMISSIONS.length);
  });

  it('denies an unknown future permission', () => {
    const { requestHandler } = createPermissionHandlers(vi.fn());
    const callback = vi.fn();
    requestHandler({}, 'some-future-capability', callback);
    expect(callback).toHaveBeenCalledWith(false);
  });

  // The synchronous check handler is easy to forget, and forgetting it means
  // some permission checks silently succeed.
  it('denies every permission through the synchronous check handler too', () => {
    const { checkHandler } = createPermissionHandlers(vi.fn());
    for (const permission of DENIED_PERMISSIONS) {
      expect(checkHandler({}, permission)).toBe(false);
    }
    expect(checkHandler({}, 'some-future-capability')).toBe(false);
  });

  it('reports what was denied so a real breakage leaves evidence', () => {
    const onDenied = vi.fn();
    const { requestHandler } = createPermissionHandlers(onDenied);
    requestHandler({}, 'geolocation', vi.fn());
    expect(onDenied).toHaveBeenCalledWith('geolocation');
  });

  it('still invokes callback with deny even if onDenied throws in requestHandler', () => {
    const onDenied = vi.fn(() => {
      throw new Error('deny error');
    });
    const { requestHandler } = createPermissionHandlers(onDenied);
    const callback = vi.fn();

    // Should not throw - callback must still be invoked with false
    requestHandler({}, 'geolocation', callback);
    expect(callback).toHaveBeenCalledWith(false);
  });

  it('still returns false even if onDenied throws in checkHandler', () => {
    const onDenied = vi.fn(() => {
      throw new Error('deny error');
    });
    const { checkHandler } = createPermissionHandlers(onDenied);

    // Should not throw - must still return false
    const result = checkHandler({}, 'geolocation');
    expect(result).toBe(false);
  });
});
