import { createClient } from '@supabase/supabase-js'

// Service-Role-Client: umgeht RLS, nur serverseitig verwenden.
export const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

// Verifiziert das Supabase-User-JWT aus dem Authorization-Header.
export async function getUserFromRequest(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return null
  const { data, error } = await db.auth.getUser(token)
  if (error || !data?.user) return null
  const { data: profile } = await db
    .from('profiles')
    .select('account_status')
    .eq('id', data.user.id)
    .maybeSingle()
  if (profile?.account_status === 'disabled') return null
  return data.user
}
