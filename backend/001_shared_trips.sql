-- Install once with the Supabase migration tool. No private credentials or trip data.
begin;
create schema if not exists cq_shared;
revoke all on schema cq_shared from public, anon, authenticated;

create table cq_shared.trips (
  id uuid primary key,
  secret_hash bytea not null,
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table cq_shared.receipts (
  trip_id uuid not null references cq_shared.trips(id) on delete cascade,
  request_id uuid not null,
  body_hash bytea not null,
  created_at timestamptz not null default now(),
  primary key (trip_id, request_id)
);
alter table cq_shared.trips enable row level security;
alter table cq_shared.receipts enable row level security;
revoke all on all tables in schema cq_shared from public, anon, authenticated;

create function cq_shared.valid_field(f text, v jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if f is null or v is null or length(f) > 180 then return false; end if;
  if f ~ '^day\.(05|06|07)\.[a-z0-9-]{1,80}$' then
    if v = 'null'::jsonb then return true; end if;
    if jsonb_typeof(v) <> 'object' then return false; end if;
    return (select count(*) from jsonb_object_keys(v)) = 2
      and v->>'slot' in ('morning','afternoon','evening')
      and jsonb_typeof(v->'active') = 'boolean';
  end if;
  if f ~ '^position\.(05|06|07)$' or f = 'stay' then
    return v = 'null'::jsonb or (jsonb_typeof(v) = 'string' and v #>> '{}' ~ '^[a-z0-9-]{1,80}$');
  end if;
  return (f ~ '^pick\.(pick|check)-[a-z0-9-]{1,100}$' or f ~ '^packing\.[a-z0-9-]{1,120}$')
    and (v = 'null'::jsonb or jsonb_typeof(v) = 'boolean');
end $$;

create function public.cq_create_trip(p_room uuid, p_secret text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r cq_shared.trips%rowtype; item record;
begin
  if p_room is null or p_secret is null or p_secret !~ '^[a-f0-9]{64}$'
    or p_data is null or jsonb_typeof(p_data) <> 'object' or octet_length(p_data::text) > 100000 then
    raise sqlstate 'PT400' using message = 'invalid_request';
  end if;
  if (select count(*) from jsonb_object_keys(p_data)) > 1500 then
    raise sqlstate 'PT400' using message = 'too_many_fields';
  end if;
  for item in select * from jsonb_each(p_data) loop
    if not coalesce(cq_shared.valid_field(item.key,item.value),false) then
      raise sqlstate 'PT400' using message = 'invalid_field';
    end if;
  end loop;
  -- Idempotent creation: a retry cannot replace an existing trip or its key.
  insert into cq_shared.trips(id,secret_hash,data)
    values(p_room,sha256(convert_to(p_secret,'UTF8')),p_data) on conflict (id) do nothing;
  select * into r from cq_shared.trips where id = p_room;
  if r.secret_hash is distinct from sha256(convert_to(p_secret,'UTF8')) then
    raise sqlstate 'PT401' using message = 'invalid_invitation';
  end if;
  return jsonb_build_object('ok',true,'data',r.data,'revision',r.revision,'updatedAt',r.updated_at);
end $$;

create function public.cq_read_trip(p_room uuid, p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r cq_shared.trips%rowtype;
begin
  if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then
    raise sqlstate 'PT401' using message = 'invalid_invitation';
  end if;
  select * into r from cq_shared.trips
    where id = p_room and secret_hash = sha256(convert_to(p_secret,'UTF8'));
  if not found then raise sqlstate 'PT401' using message = 'invalid_invitation'; end if;
  return jsonb_build_object('ok',true,'data',r.data,'revision',r.revision,'updatedAt',r.updated_at);
end $$;

create function public.cq_patch_trip(p_room uuid, p_secret text, p_request_id uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r cq_shared.trips%rowtype; c jsonb; receipt_hash bytea;
  conflicts jsonb := '[]'::jsonb; next_data jsonb;
begin
  if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then
    raise sqlstate 'PT401' using message = 'invalid_invitation';
  end if;
  if p_request_id is null or p_changes is null or jsonb_typeof(p_changes) <> 'array'
    or jsonb_array_length(p_changes) < 1 or jsonb_array_length(p_changes) > 100
    or octet_length(p_changes::text) > 50000 then
    raise sqlstate 'PT400' using message = 'invalid_changes';
  end if;
  for c in select value from jsonb_array_elements(p_changes) loop
    if jsonb_typeof(c) <> 'object' or not(c ? 'before' and c ? 'after')
      or not coalesce(cq_shared.valid_field(c->>'field',c->'before'),false)
      or not coalesce(cq_shared.valid_field(c->>'field',c->'after'),false) then
      raise sqlstate 'PT400' using message = 'invalid_change';
    end if;
  end loop;
  if (select count(distinct value->>'field') from jsonb_array_elements(p_changes)) <> jsonb_array_length(p_changes) then
    raise sqlstate 'PT400' using message = 'duplicate_field';
  end if;
  -- Row locking makes comparison and updates atomic across both phones.
  select * into r from cq_shared.trips
    where id = p_room and secret_hash = sha256(convert_to(p_secret,'UTF8')) for update;
  if not found then raise sqlstate 'PT401' using message = 'invalid_invitation'; end if;
  select body_hash into receipt_hash from cq_shared.receipts
    where trip_id = p_room and request_id = p_request_id;
  if found then
    if receipt_hash <> sha256(convert_to(p_changes::text,'UTF8')) then
      raise sqlstate 'PT400' using message = 'request_id_reused';
    end if;
    return jsonb_build_object('ok',true,'data',r.data,'revision',r.revision,'updatedAt',r.updated_at);
  end if;
  for c in select value from jsonb_array_elements(p_changes) loop
    if coalesce(r.data->(c->>'field'),'null'::jsonb) is distinct from c->'before'
       and coalesce(r.data->(c->>'field'),'null'::jsonb) is distinct from c->'after' then
      conflicts := conflicts || jsonb_build_array(c->>'field');
    end if;
  end loop;
  if jsonb_array_length(conflicts) > 0 then
    return jsonb_build_object('ok',false,'conflicts',conflicts,'data',r.data,'revision',r.revision,'updatedAt',r.updated_at);
  end if;
  next_data := r.data;
  for c in select value from jsonb_array_elements(p_changes) loop
    next_data := jsonb_set(next_data,array[c->>'field'],c->'after',true);
  end loop;
  if octet_length(next_data::text) > 100000 or (select count(*) from jsonb_object_keys(next_data)) > 1500 then
    raise sqlstate 'PT400' using message = 'trip_full';
  end if;
  update cq_shared.trips set data=next_data,revision=revision+1,updated_at=clock_timestamp()
    where id=p_room returning * into r;
  insert into cq_shared.receipts(trip_id,request_id,body_hash)
    values(p_room,p_request_id,sha256(convert_to(p_changes::text,'UTF8')));
  return jsonb_build_object('ok',true,'data',r.data,'revision',r.revision,'updatedAt',r.updated_at);
end $$;

revoke all on all functions in schema cq_shared from public, anon, authenticated;
revoke all on function public.cq_create_trip(uuid,text,jsonb) from public;
revoke all on function public.cq_read_trip(uuid,text) from public;
revoke all on function public.cq_patch_trip(uuid,text,uuid,jsonb) from public;
grant execute on function public.cq_create_trip(uuid,text,jsonb) to anon, authenticated;
grant execute on function public.cq_read_trip(uuid,text) to anon, authenticated;
grant execute on function public.cq_patch_trip(uuid,text,uuid,jsonb) to anon, authenticated;
commit;

