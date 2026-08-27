alter table ai_messages add column provider text;
alter table ai_messages add column model text;
alter table ai_messages add column input_tokens integer;
alter table ai_messages add column output_tokens integer;
