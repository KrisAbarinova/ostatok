/**
 * Публичные параметры подключения.
 *
 * Здесь только те значения, которые по замыслу открыты всем: адрес проекта
 * и publishable-ключ. Ключ не даёт доступа к таблицам — RLS включён, политик нет,
 * а все данные идут через Edge Function.
 *
 * Service role key и Telegram Bot Token сюда не попадают никогда.
 */
window.APP_CONFIG = {
  SUPABASE_URL: 'https://guumcbwybldxelogpjpo.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_3smgz2OFbkJA8BZMsTcyDw_wKYp7ela',
};
