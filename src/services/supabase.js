import { createClient } from "@supabase/supabase-js";

import { env } from "../config.js";

export const createRequestSupabaseClient = (accessToken) =>
  createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });

export const getAuthenticatedUser = async (accessToken) => {
  const client = createRequestSupabaseClient(accessToken);
  const { data, error } = await client.auth.getUser(accessToken);
  if (error) {
    throw error;
  }
  return data.user;
};

export const createAdminSupabaseClient = () =>
  createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
