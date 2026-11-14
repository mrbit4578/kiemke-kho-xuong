-- Shared workspace storage for the inventory app.
-- Run this in the Supabase SQL editor before setting VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.

create extension if not exists pgcrypto;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.workspace_records (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  entity_type text not null check (entity_type in ('material', 'bom', 'order', 'inventory', 'norm', 'production_order', 'product_mapping', 'chemical_norm', 'import_meta')),
  entity_key text not null,
  payload jsonb not null,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, entity_type, entity_key)
);

alter table public.workspace_records
  drop constraint if exists workspace_records_entity_type_check;
alter table public.workspace_records
  add constraint workspace_records_entity_type_check
  check (entity_type in ('material', 'bom', 'order', 'inventory', 'norm', 'production_order', 'product_mapping', 'chemical_norm', 'import_meta'));

create index if not exists workspace_records_workspace_type_idx
  on public.workspace_records (workspace_id, entity_type);

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = target_workspace and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_editor(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = target_workspace
      and m.user_id = auth.uid()
      and m.role in ('owner', 'editor')
  );
$$;

create or replace function public.create_default_workspace(workspace_name text default 'Kho xưởng')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_workspace uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select workspace_id into new_workspace
  from public.workspace_members
  where user_id = auth.uid()
  order by created_at
  limit 1;

  if new_workspace is null then
    if exists (select 1 from public.workspaces) then
      raise exception 'Workspace membership must be assigned by an administrator';
    end if;
    insert into public.workspaces (name) values (workspace_name)
    returning id into new_workspace;
    insert into public.workspace_members (workspace_id, user_id, role)
    values (new_workspace, auth.uid(), 'owner');
  end if;

  return new_workspace;
end;
$$;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_records enable row level security;

drop policy if exists "members can read their workspaces" on public.workspaces;
create policy "members can read their workspaces"
  on public.workspaces for select to authenticated
  using (public.is_workspace_member(id));

drop policy if exists "members can read workspace membership" on public.workspace_members;
create policy "members can read workspace membership"
  on public.workspace_members for select to authenticated
  using (user_id = auth.uid() or public.is_workspace_member(workspace_id));

drop policy if exists "members can read workspace records" on public.workspace_records;
create policy "members can read workspace records"
  on public.workspace_records for select to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "editors can insert workspace records" on public.workspace_records;
create policy "editors can insert workspace records"
  on public.workspace_records for insert to authenticated
  with check (public.is_workspace_editor(workspace_id));

drop policy if exists "editors can update workspace records" on public.workspace_records;
create policy "editors can update workspace records"
  on public.workspace_records for update to authenticated
  using (public.is_workspace_editor(workspace_id))
  with check (public.is_workspace_editor(workspace_id));

drop policy if exists "editors can delete workspace records" on public.workspace_records;
create policy "editors can delete workspace records"
  on public.workspace_records for delete to authenticated
  using (public.is_workspace_editor(workspace_id));

grant usage on schema public to authenticated;
grant select on public.workspaces, public.workspace_members to authenticated;
grant select, insert, update, delete on public.workspace_records to authenticated;
grant execute on function public.create_default_workspace(text) to authenticated;
