import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('./api', () => ({
  listCourses: vi.fn(),
  listAssignments: vi.fn(),
  listAnnouncements: vi.fn(),
  listModules: vi.fn(),
  listModuleItems: vi.fn(),
  listFiles: vi.fn(),
  getPage: vi.fn(),
  getFile: vi.fn(),
  getSelf: vi.fn(),
}));

import * as api from './api';
import { CanvasAuthError, CanvasNetworkError } from './errors';
import { syncCourseContent, fetchPageBody, getSyncState, courseContentKey } from './sync';

const CREDS = { baseUrl: 'https://uncw.instructure.com', token: 'test-token' };

const SCHEMA = `
create table canvas_courses (
  id integer primary key, name text not null, course_code text, term_name text,
  current_score real, current_grade text, synced_at text not null default (datetime('now'))
);
create table canvas_modules (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  name text, position integer, synced_at text not null default (datetime('now'))
);
create table canvas_module_items (
  id integer primary key,
  module_id integer not null references canvas_modules(id) on delete cascade,
  course_id integer not null, title text, type text, content_id integer,
  page_url text, html_url text, external_url text, position integer
);
create table canvas_files (
  id integer primary key,
  course_id integer not null references canvas_courses(id) on delete cascade,
  display_name text, filename text, content_type text, size integer,
  updated_at text, synced_at text not null default (datetime('now'))
);
create table canvas_pages (
  course_id integer not null references canvas_courses(id) on delete cascade,
  url text not null, title text, body text, updated_at text,
  synced_at text not null default (datetime('now')), primary key (course_id, url)
);
create table canvas_sync_state (key text primary key, value text not null);
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare('insert into canvas_courses (id, name) values (?, ?)').run(101, 'Statistics');
  return db;
}

beforeEach(() => {
  vi.mocked(api.listModules).mockReset();
  vi.mocked(api.listModuleItems).mockReset();
  vi.mocked(api.listFiles).mockReset();
  vi.mocked(api.getPage).mockReset();
  vi.mocked(api.listFiles).mockResolvedValue([]);
});

describe('syncCourseContent', () => {
  it('stores modules and their inlined items', async () => {
    vi.mocked(api.listModules).mockResolvedValue([
      {
        id: 10,
        name: 'Week 1',
        position: 1,
        items: [
          { id: 1000, title: 'Syllabus', type: 'Page', page_url: 'syllabus', position: 1 },
          { id: 1001, title: 'Slides', type: 'File', content_id: 7, position: 2 },
        ],
      },
    ]);
    const db = makeDb();

    const result = await syncCourseContent(db, CREDS, 101);

    expect(result.ok).toBe(true);
    const module = db.prepare('select * from canvas_modules where id = 10').get() as Record<string, unknown>;
    expect(module.name).toBe('Week 1');
    const items = db.prepare('select id, type from canvas_module_items order by position').all() as {
      id: number;
      type: string;
    }[];
    expect(items).toEqual([
      { id: 1000, type: 'Page' },
      { id: 1001, type: 'File' },
    ]);
  });

  it('falls back to a per-module item request when Canvas omits items', async () => {
    vi.mocked(api.listModules).mockResolvedValue([{ id: 10, name: 'Huge module', position: 1 }]);
    vi.mocked(api.listModuleItems).mockResolvedValue([
      { id: 2000, title: 'Reading', type: 'Page', page_url: 'reading', position: 1 },
    ]);
    const db = makeDb();

    await syncCourseContent(db, CREDS, 101);

    expect(api.listModuleItems).toHaveBeenCalledWith(CREDS, 101, 10);
    const count = db.prepare('select count(*) as c from canvas_module_items').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('creates a page stub with a null body for each Page item', async () => {
    vi.mocked(api.listModules).mockResolvedValue([
      { id: 10, name: 'Week 1', items: [{ id: 1000, title: 'Syllabus', type: 'Page', page_url: 'syllabus' }] },
    ]);
    const db = makeDb();

    await syncCourseContent(db, CREDS, 101);

    const page = db.prepare('select title, body from canvas_pages where course_id = 101 and url = ?').get('syllabus') as {
      title: string;
      body: string | null;
    };
    expect(page.title).toBe('Syllabus');
    expect(page.body).toBeNull();
    expect(api.getPage).not.toHaveBeenCalled();
  });

  it('stores the course file list', async () => {
    vi.mocked(api.listModules).mockResolvedValue([]);
    vi.mocked(api.listFiles).mockResolvedValue([
      { id: 7, display_name: 'Lecture 1.pdf', filename: 'lecture1.pdf', 'content-type': 'application/pdf', size: 1024 },
    ]);
    const db = makeDb();

    await syncCourseContent(db, CREDS, 101);

    const file = db.prepare('select * from canvas_files where id = 7').get() as Record<string, unknown>;
    expect(file.display_name).toBe('Lecture 1.pdf');
    expect(file.content_type).toBe('application/pdf');
    expect(file.size).toBe(1024);
  });

  it('degrades to no files when the instructor has disabled the files tab', async () => {
    vi.mocked(api.listModules).mockResolvedValue([]);
    vi.mocked(api.listFiles).mockRejectedValue(new CanvasNetworkError('Canvas returned 403: unauthorized'));
    const db = makeDb();

    const result = await syncCourseContent(db, CREDS, 101);

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(1);
    const count = db.prepare('select count(*) as c from canvas_files').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('is idempotent and prunes modules removed from Canvas', async () => {
    const db = makeDb();
    vi.mocked(api.listModules).mockResolvedValue([
      { id: 10, name: 'Week 1', items: [] },
      { id: 11, name: 'Week 2', items: [] },
    ]);
    await syncCourseContent(db, CREDS, 101);

    vi.mocked(api.listModules).mockResolvedValue([{ id: 10, name: 'Week 1', items: [] }]);
    await syncCourseContent(db, CREDS, 101);

    const ids = (db.prepare('select id from canvas_modules order by id').all() as { id: number }[]).map((r) => r.id);
    expect(ids).toEqual([10]);
  });

  it('records the per-course content sync timestamp', async () => {
    vi.mocked(api.listModules).mockResolvedValue([]);
    const db = makeDb();

    await syncCourseContent(db, CREDS, 101, new Date('2026-08-18T12:00:00Z'));

    expect(getSyncState(db, courseContentKey(101))).toBe('2026-08-18T12:00:00.000Z');
  });

  it('reports tokenInvalid without throwing on auth failure', async () => {
    vi.mocked(api.listModules).mockRejectedValue(new CanvasAuthError());
    const db = makeDb();

    const result = await syncCourseContent(db, CREDS, 101);

    expect(result.ok).toBe(false);
    expect(result.tokenInvalid).toBe(true);
    expect(getSyncState(db, 'token_invalid')).toBe('1');
  });
});

describe('fetchPageBody', () => {
  it('fetches the body once and caches it in canvas_pages', async () => {
    vi.mocked(api.listModules).mockResolvedValue([
      { id: 10, name: 'Week 1', items: [{ id: 1000, title: 'Syllabus', type: 'Page', page_url: 'syllabus' }] },
    ]);
    const db = makeDb();
    await syncCourseContent(db, CREDS, 101);

    vi.mocked(api.getPage).mockResolvedValue({ url: 'syllabus', title: 'Syllabus', body: '<p>Read this</p>' });
    const body = await fetchPageBody(db, CREDS, 101, 'syllabus');

    expect(body).toBe('<p>Read this</p>');
    const stored = db.prepare('select body from canvas_pages where course_id = 101 and url = ?').get('syllabus') as {
      body: string;
    };
    expect(stored.body).toBe('<p>Read this</p>');
  });

  it('inserts a page row even when the page was not part of any module', async () => {
    const db = makeDb();
    vi.mocked(api.getPage).mockResolvedValue({ url: 'orphan', title: 'Orphan', body: '<p>hi</p>' });

    await fetchPageBody(db, CREDS, 101, 'orphan');

    const stored = db.prepare('select title from canvas_pages where course_id = 101 and url = ?').get('orphan') as {
      title: string;
    };
    expect(stored.title).toBe('Orphan');
  });

  it('returns null and does not throw when Canvas rejects the page', async () => {
    const db = makeDb();
    vi.mocked(api.getPage).mockRejectedValue(new CanvasNetworkError('404'));

    await expect(fetchPageBody(db, CREDS, 101, 'missing')).resolves.toBeNull();
  });
});
