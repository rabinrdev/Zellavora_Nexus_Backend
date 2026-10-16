import { createSupabaseContext, type SupabaseContext } from '@supabase/server';

/**
 * Verifies a Supabase user JWT on a Web API `Request` and returns the request context
 * (`supabase` client scoped to the caller, `userClaims`, `jwtClaims`).
 * Throws the library's `AuthError` on a missing or invalid token; it exposes `status` and `toJSON()`.
 */
export async function authenticateUser(request: Request): Promise<SupabaseContext> {
  const { data, error } = await createSupabaseContext(request, { auth: 'user' });
  if (error) throw error;
  return data;
}
