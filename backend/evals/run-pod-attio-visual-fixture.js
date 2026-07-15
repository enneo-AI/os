import { db } from '../src/db.js'
import { searchAttioRecords } from '../src/tools/attio.js'

const email = `pod-attio-visual-${Date.now()}@example.invalid`
const password = `Visual-${crypto.randomUUID()}-Aa1!`
let userId = null
let podId = null

async function cleanup() {
  if (podId) await db.from('pods').delete().eq('id', podId)
  if (userId) await db.auth.admin.deleteUser(userId)
}

try {
  const { data: auth, error: authError } = await db.auth.admin.createUser({ email, password, email_confirm: true })
  if (authError) throw authError
  userId = auth.user.id
  const { error: profileError } = await db.from('profiles').update({ is_admin: true, display_name: 'Attio Visual Admin' }).eq('id', userId)
  if (profileError) throw profileError

  const { data: pod, error: podError } = await db.from('pods').insert({
    name: 'STAWAG Rollout',
    description: 'Produktiver AI-Agent-Rollout mit dem Customer-Success-Team',
    open: false,
    created_by: userId,
  }).select().single()
  if (podError) throw podError
  podId = pod.id

  const [company] = await searchAttioRecords(userId, 'companies', 'STAWAG', 1)
  if (!company) throw new Error('Kein STAWAG-Record in Attio gefunden')
  const { error: linkError } = await db.from('pod_attio_links').insert({
    pod_id: podId,
    attio_record_id: company.record_id,
    record_name: company.name,
    record_domain: company.domain,
    record_url: company.web_url,
    snapshot: company,
    linked_by: userId,
  })
  if (linkError) throw linkError

  console.log(JSON.stringify({ ready: true, email, password, podId }))
  process.stdin.resume()
  await new Promise((resolve) => process.stdin.once('data', resolve))
  process.stdin.pause()
} finally {
  await cleanup()
}
