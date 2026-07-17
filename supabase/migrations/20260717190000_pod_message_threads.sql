-- Slack-artige Threads in Pod-Konversationen. Root-Nachrichten bleiben im
-- Hauptverlauf; Antworten verweisen immer direkt auf genau diese Root-Nachricht.
alter table public.messages
  add column if not exists thread_root_id uuid references public.messages(id) on delete cascade;

create index if not exists messages_conversation_thread_created_idx
  on public.messages (conversation_id, thread_root_id, created_at);

create or replace function public.validate_message_thread()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  root_message public.messages%rowtype;
  pod_uuid uuid;
begin
  if new.thread_root_id is null then
    return new;
  end if;

  select * into root_message from public.messages where id = new.thread_root_id;
  if not found then
    raise exception 'Thread-Hauptnachricht nicht gefunden';
  end if;
  if root_message.conversation_id <> new.conversation_id then
    raise exception 'Thread und Nachricht gehören nicht zur selben Konversation';
  end if;
  if root_message.thread_root_id is not null then
    raise exception 'Thread-Antworten dürfen nicht weiter verschachtelt werden';
  end if;
  if root_message.role <> 'user' then
    raise exception 'Threads können nur an Nachrichten von Personen hängen';
  end if;

  select pod_id into pod_uuid from public.conversations where id = new.conversation_id;
  if pod_uuid is null then
    raise exception 'Threads sind nur in Pods verfügbar';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_validate_thread on public.messages;
create trigger messages_validate_thread
before insert or update of thread_root_id, conversation_id on public.messages
for each row execute function public.validate_message_thread();
