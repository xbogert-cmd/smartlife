create table ai_conversations (
  id text primary key,
  title text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create table ai_messages (
  id text primary key,
  conversation_id text not null references ai_conversations(id) on delete cascade,
  role text not null,
  content text not null,
  created_at text not null default (datetime('now'))
);

create index ai_messages_conversation_idx on ai_messages(conversation_id, created_at);
