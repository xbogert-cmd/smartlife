import { describe, expect, it } from 'vitest';
import {
  DENIED_PERMISSIONS,
  isAllowedNavigationUrl,
  sanitizeDownloadFilename,
  shouldAllowPermission,
} from './security';

describe('isAllowedNavigationUrl', () => {
  it.each([
    ['https://uncw.edu/', true],
    ['http://localhost:5173/', true],
    ['about:blank', true],
    ['file:///Users/alexanderbogert/.ssh/id_rsa', false],
    ['file:///etc/passwd', false],
    ['data:text/html,<h1>spoof</h1>', false],
    ['blob:https://evil.test/1234', false],
    ['javascript:alert(1)', false],
    ['smartlife://internal', false],
    ['chrome://settings', false],
    ['ftp://files.test/x', false],
    ['not a url at all', false],
    ['', false],
  ])('%s -> %s', (url, expected) => {
    expect(isAllowedNavigationUrl(url)).toBe(expected);
  });

  it('rejects about: targets other than about:blank', () => {
    expect(isAllowedNavigationUrl('about:config')).toBe(false);
  });

  it('is not fooled by uppercase or padded schemes', () => {
    expect(isAllowedNavigationUrl('JavaScript:alert(1)')).toBe(false);
    expect(isAllowedNavigationUrl('  file:///etc/passwd')).toBe(false);
  });
});

describe('shouldAllowPermission', () => {
  it('denies every permission Electron can ask about', () => {
    for (const permission of DENIED_PERMISSIONS) {
      expect(shouldAllowPermission(permission)).toBe(false);
    }
  });

  it('denies permissions it has never heard of', () => {
    expect(shouldAllowPermission('some-future-capability')).toBe(false);
  });

  it('covers the permissions that actually matter', () => {
    expect(DENIED_PERMISSIONS).toEqual(
      expect.arrayContaining(['media', 'geolocation', 'notifications', 'display-capture', 'openExternal'])
    );
  });
});

describe('sanitizeDownloadFilename', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['/absolute/path/file.txt', 'file.txt'],
    ['..\\..\\windows\\system32\\evil.exe', 'evil.exe'],
    ['syllabus (1).pdf', 'syllabus (1).pdf'],
    ['.hidden', 'hidden'],
  ])('%s -> %s', (raw, expected) => {
    expect(sanitizeDownloadFilename(raw)).toBe(expected);
  });

  it.each(['', '   ', '..', '../', '/', '.'])('falls back to "download" for %s', (raw) => {
    expect(sanitizeDownloadFilename(raw)).toBe('download');
  });

  it('strips control characters', () => {
    const withBell = `re${String.fromCharCode(7)}port.pdf`;
    expect(sanitizeDownloadFilename(withBell)).toBe('report.pdf');
  });

  it('caps absurdly long names', () => {
    expect(sanitizeDownloadFilename(`${'a'.repeat(400)}.pdf`)).toHaveLength(255);
  });
});
