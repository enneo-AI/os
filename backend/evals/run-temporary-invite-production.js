import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'

const url = process.env.SUPABASE_URL
const service = process.env.SUPABASE_SERVICE_ROLE_KEY
const anon = process.env.SUPABASE_ANON_KEY
const backend = process.env.PRODUCTION_API_URL || 'https://enneo-os-backend-production.up.railway.app'
if (!url || !service || !anon) throw new Error('Supabase env incomplete')

const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } })
const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`
const adminEmail = `temp-admin-${stamp}@example.invalid`
const targetEmail = `temp-invite-${stamp}@example.invalid`
const adminPassword = `Adm!7-${randomBytes(12).toString('base64url')}`
const ownPassword = `Own!8-${randomBytes(12).toString('base64url')}`
const ids = []

try {
  let result = await admin.auth.admin.createUser({ email: adminEmail, password: adminPassword, email_confirm: true })
  if (result.error) throw result.error
  ids.push(result.data.user.id)
  let query = await admin.from('profiles').update({
    is_admin: true,
    onboarding_completed_at: new Date().toISOString(),
    tour_completed_at: new Date().toISOString(),
  }).eq('id', result.data.user.id)
  if (query.error) throw query.error

  const adminClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } })
  const login = await adminClient.auth.signInWithPassword({ email: adminEmail, password: adminPassword })
  if (login.error) throw login.error

  const response = await fetch(`${backend}/api/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${login.data.session.access_token}`,
    },
    body: JSON.stringify({ email: targetEmail, role: 'member' }),
  })
  const invite = await response.json()
  if (!response.ok) throw new Error(`Invite endpoint ${response.status}: ${invite.error}`)
  if (!invite.temporary_password || invite.link) throw new Error('Unexpected invite response shape')

  const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (listed.error) throw listed.error
  const target = listed.data.users.find((user) => user.email === targetEmail)
  if (!target) throw new Error('Target auth user missing')
  ids.push(target.id)
  if (!target.email_confirmed_at) throw new Error('Target email is not confirmed')
  const profile = await admin.from('profiles')
    .select('is_admin,onboarding_completed_at,tour_completed_at')
    .eq('id', target.id).single()
  if (profile.error) throw profile.error
  if (profile.data.is_admin || profile.data.onboarding_completed_at || profile.data.tour_completed_at) {
    throw new Error('Target onboarding state is not clean')
  }

  const targetClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } })
  const firstLogin = await targetClient.auth.signInWithPassword({
    email: targetEmail,
    password: invite.temporary_password,
  })
  if (firstLogin.error) throw firstLogin.error
  const passwordUpdate = await targetClient.auth.updateUser({ password: ownPassword })
  if (passwordUpdate.error) throw passwordUpdate.error
  query = await targetClient.from('profiles')
    .update({ onboarding_completed_at: new Date().toISOString() }).eq('id', target.id)
  if (query.error) throw query.error
  await targetClient.auth.signOut({ scope: 'local' })

  const oldAttempt = await targetClient.auth.signInWithPassword({
    email: targetEmail,
    password: invite.temporary_password,
  })
  if (!oldAttempt.error) throw new Error('Temporary password still works after replacement')
  const newAttempt = await targetClient.auth.signInWithPassword({ email: targetEmail, password: ownPassword })
  if (newAttempt.error) throw newAttempt.error

  console.log(JSON.stringify({
    pass: true,
    checks: [
      'production invite endpoint returns credentials without link',
      'account is confirmed and onboarding is mandatory',
      'temporary password signs in',
      'personal password replaces temporary password',
      'temporary password is rejected afterwards',
      'personal password signs in afterwards',
    ],
  }))
} finally {
  for (const id of ids.reverse()) {
    await admin.from('profiles').delete().eq('id', id)
    await admin.auth.admin.deleteUser(id)
  }
}
