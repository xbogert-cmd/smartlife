-- Browsing history, used only for address-bar suggestions. There is no
-- browsable history page in this phase, and rows are pruned to 90 days on
-- every app start so the table cannot grow without bound.
create table browser_history (
  url text not null,
  title text,
  visited_at text not null default (datetime('now'))
);

create index browser_history_visited_idx on browser_history(visited_at desc);
create index browser_history_url_idx on browser_history(url);
