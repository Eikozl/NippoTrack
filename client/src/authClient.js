import { createClient } from '@supabase/supabase-js';

const defaultUrl = 'https://milayuvlajmgrcxmrxdg.supabase.co';
const defaultPublishableKey = 'sb_publishable_UJQwQKZge3SKbj-j-BfVkg_2QmvbX4O';
const url = import.meta.env.VITE_SUPABASE_URL || defaultUrl;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || defaultPublishableKey;

export const authConfigured = Boolean(url && key);
export const supabase = authConfigured
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

export async function accessToken() {
  const { data } = await supabase?.auth.getSession() || { data: { session: null } };
  return data.session?.access_token || null;
}
