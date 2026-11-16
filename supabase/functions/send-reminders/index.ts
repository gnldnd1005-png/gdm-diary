// 매분 cron이 호출: 시간이 된 알림을 알림 켠 모든 기기로 보냄
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT")!,
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  const now = Date.now();
  const { data: due, error } = await sb.from("reminders").select("*")
    .eq("sent", false).lte("due_at", new Date(now).toISOString());
  if (error) return new Response(error.message, { status: 500 });
  if (!due?.length) return new Response("0");

  await sb.from("reminders").update({ sent: true }).in("id", due.map((r) => r.id));
  const { data: subs } = await sb.from("push_subs").select("*");

  let sent = 0;
  for (const r of due) {
    // 30분 넘게 밀린 알림은 버림
    if (now - new Date(r.due_at).getTime() > 30 * 60e3) continue;
    // 공복 혈당을 이미 기록했으면 알림 생략
    if (r.key.startsWith("fasting-")) {
      const { data: done } = await sb.from("entries").select("id")
        .eq("day", r.key.slice(8)).eq("slot", "fasting").not("glucose", "is", null).maybeSingle();
      if (done) continue;
    }
    const payload = JSON.stringify({ title: r.title, body: r.body, tag: r.key });
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification(s.sub, payload, { TTL: 1800 });
        sent++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await sb.from("push_subs").delete().eq("endpoint", s.endpoint);
        else console.error(err);
      }
    }
  }
  return new Response(String(sent));
});
