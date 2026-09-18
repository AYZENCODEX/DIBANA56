import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string) ?? "";
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) ?? "";

function createSafeClient(): SupabaseClient {
  if (supabaseUrl && supabaseAnonKey) {
    try {
      return createClient(supabaseUrl, supabaseAnonKey);
    } catch {
      // fall through to stub
    }
  }
  // Stub so the app renders even when Supabase env vars aren't baked in
  return {
    auth: {
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
      signInWithOAuth: async () => ({
        data: null,
        error: { message: "Supabase is not configured on this deployment." } as any,
      }),
      signUp: async () => ({
        data: null,
        error: { message: "Supabase is not configured on this deployment." } as any,
      }),
      signOut: async () => ({ error: null }),
    },
  } as unknown as SupabaseClient;
}

export const supabase = createSafeClient();
