-- 혈당일기 DB 스키마 (Supabase SQL Editor에서 한 번 실행)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 하루 기록: 공복/아침/점심/저녁은 하루 1건, 간식은 여러 건
create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  slot text not null check (slot in ('fasting', 'breakfast', 'lunch', 'dinner', 'snack')),
  meal_at timestamptz,
  food text,
  food_photo text,
  post_hours int check (post_hours in (1, 2)),
  glucose int check (glucose between 10 and 700),
  glucose_at timestamptz,
  glucose_photo text,
  memo text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 식후 운동 여부 (null = 미입력)
alter table public.entries add column if not exists exercise boolean;
alter table public.entries add column if not exists exercise_min int check (exercise_min between 1 and 300);
create unique index if not exists entries_day_slot_uniq on public.entries (day, slot) where slot <> 'snack';
create index if not exists entries_day_idx on public.entries (day);

-- 부부 공용 설정 (1행)
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb
);
insert into public.settings (id) values (1) on conflict do nothing;

-- 예약 알림
create table if not exists public.reminders (
  id bigint generated always as identity primary key,
  key text not null unique,
  due_at timestamptz not null,
  title text not null,
  body text,
  sent boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists reminders_due_idx on public.reminders (due_at) where not sent;

-- 알림 받을 기기
create table if not exists public.push_subs (
  endpoint text primary key,
  sub jsonb not null,
  device text,
  user_id uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- 로그인한 사람(부부)만 접근
alter table public.entries enable row level security;
alter table public.settings enable row level security;
alter table public.reminders enable row level security;
alter table public.push_subs enable row level security;
drop policy if exists members on public.entries;
drop policy if exists members on public.settings;
drop policy if exists members on public.reminders;
drop policy if exists members on public.push_subs;
create policy members on public.entries for all to authenticated using (true) with check (true);
create policy members on public.settings for all to authenticated using (true) with check (true);
create policy members on public.reminders for all to authenticated using (true) with check (true);
create policy members on public.push_subs for all to authenticated using (true) with check (true);

-- 사진 저장소 (비공개)
insert into storage.buckets (id, name, public) values ('photos', 'photos', false) on conflict do nothing;
drop policy if exists "members photos select" on storage.objects;
drop policy if exists "members photos insert" on storage.objects;
drop policy if exists "members photos update" on storage.objects;
drop policy if exists "members photos delete" on storage.objects;
create policy "members photos select" on storage.objects for select to authenticated using (bucket_id = 'photos');
create policy "members photos insert" on storage.objects for insert to authenticated with check (bucket_id = 'photos');
create policy "members photos update" on storage.objects for update to authenticated using (bucket_id = 'photos');
create policy "members photos delete" on storage.objects for delete to authenticated using (bucket_id = 'photos');

-- 다른 기기 변경 실시간 반영
do $$ begin
  alter publication supabase_realtime add table public.entries, public.settings;
exception when duplicate_object then null; end $$;

-- 매분 알림 발송 (setup 단계에서 <PROJECT_REF>, <CRON_SECRET> 치환)
-- select cron.schedule('send-reminders', '* * * * *', $$
--   select net.http_post(
--     url := 'https://<PROJECT_REF>.supabase.co/functions/v1/send-reminders',
--     headers := '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
--     body := '{}'::jsonb)
-- $$);
