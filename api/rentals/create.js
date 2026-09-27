import { supabase } from '../_lib/supabase.js'
import { setCors } from '../_lib/cors.js'
import { verify, fromHeader } from '../_lib/jwt.js'
import { makeInvoice } from '../_lib/nwc.js'

const POOLS = {
  ocean: { name: 'OCEAN', url: 'stratum+tcp://mine.ocean.xyz:3334' },
  foundry: { name: 'Foundry USA', url: 'stratum+tcp://btc.foundryusapool.com:3333' },
  luxor: { name: 'Luxor', url: 'stratum+tcp://btc.global.luxor.tech:700' },
  public: { name: 'Public Pool', url: 'stratum+tcp://public-pool.io:21496' },
  chauffagistes: { name: 'Chauffagistes', url: 'stratum+tcp://chauffagistes-pool.fr:3333' },
  btc_pow_lab: { name: 'BTC PoW Lab', url: 'stratum+tcp://stratum.btcpowlab-pool.com:3333' },
}

const INVOICE_TTL_MS = 60 * 60 * 1000 // 1 hour

function isValidBitcoinAddress(addr) {
  return (
    /^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addr) || // P2PKH
    /^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addr) || // P2SH
    /^bc1[a-z0-9]{6,87}$/.test(addr)               // Bech32
  )
}

export default async function handler(req, res) {
  if (setCors(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const token = fromHeader(req.headers.authorization)
  const payload = token ? verify(token) : null
  if (!payload) return res.status(401).json({ error: 'Authentication required' })

  const { miner_id, duration_minutes, pool_id, payout_address, worker_name } = req.body || {}

  // Validate inputs
  if (!miner_id || !duration_minutes || !pool_id || !payout_address) {
    return res.status(400).json({
      error: 'Required: miner_id, duration_minutes, pool_id, payout_address',
    })
  }
  if (!Number.isInteger(duration_minutes) || duration_minutes < 1 || duration_minutes > 1440) {
    return res.status(400).json({ error: 'duration_minutes must be an integer between 1 and 1440' })
  }
  if (!POOLS[pool_id]) {
    return res.status(400).json({ error: `Unknown pool. Options: ${Object.keys(POOLS).join(', ')}` })
  }
  if (!isValidBitcoinAddress(payout_address)) {
    return res.status(400).json({ error: 'Invalid Bitcoin payout address' })
  }
  // worker_name optional — alphanumeric + hyphens, max 32 chars
  const workerName = worker_name ? worker_name.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) : 'bitrent'

  // Get miner — must be online and not admin-disabled
  const { data: miner, error: minerErr } = await supabase
    .from('mineurs')
    .select('id, name, sats_per_minute, status, ip_address, port, metadata')
    .eq('id', miner_id)
    .single()

  if (minerErr || !miner) return res.status(404).json({ error: 'Miner not found' })
  if (miner.status !== 'online') return res.status(409).json({ error: 'Miner is offline' })
  if (miner.metadata?.disabled === true) {
    return res.status(409).json({ error: 'Miner temporarily disabled by admin' })
  }

  // Check no overlapping active rental
  const { count: overlap } = await supabase
    .from('rentals')
    .select('id', { count: 'exact', head: true })
    .eq('mineur_id', miner_id)
    .eq('status', 'active')

  if (overlap > 0) {
    return res.status(409).json({ error: 'Miner is already rented. Try another miner.' })
  }

  // Get user record
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('pubkey_nostr', payload.pubkey)
    .single()

  if (!user) return res.status(404).json({ error: 'User not found' })

  const totalSats = miner.sats_per_minute * duration_minutes
  const now = new Date()
  const startTime = now.toISOString()
  const endTime = new Date(now.getTime() + duration_minutes * 60 * 1000).toISOString()
  const invoiceExpiresAt = new Date(now.getTime() + INVOICE_TTL_MS).toISOString()

  // Create real Lightning invoice via NWC
  let invoice, paymentHash
  try {
    const result = await makeInvoice(
      totalSats,
      `BitRent: ${miner.name} for ${duration_minutes} min`
    )
    invoice = result.invoice
    paymentHash = result.payment_hash
  } catch (nwcErr) {
    console.error('[rentals/create] NWC error:', nwcErr.message)
    return res.status(502).json({ error: 'Lightning payment provider unavailable. Try again.' })
  }

  // Insert rental
  const { data: rental, error: rentalErr } = await supabase
    .from('rentals')
    .insert({
      mineur_id: miner_id,
      user_id: user.id,
      start_time: startTime,
      end_time: endTime,
      duration_minutes,
      sats_per_minute: miner.sats_per_minute,
      total_sats: totalSats,
      status: 'pending',
      invoice_hash: paymentHash,
      metadata: {
        pool_id,
        pool_name: POOLS[pool_id].name,
        pool_url: POOLS[pool_id].url,
        payout_address,
        worker_name: workerName,
        invoice_expires_at: invoiceExpiresAt,
      },
    })
    .select('id')
    .single()

  if (rentalErr) {
    console.error('[rentals/create] DB error:', rentalErr.message)
    return res.status(500).json({ error: 'Failed to create rental' })
  }

  // Insert payment record
  await supabase.from('payments').insert({
    rental_id: rental.id,
    invoice_hash: paymentHash,
    amount_sats: totalSats,
    status: 'pending',
    wallet_pubkey: payload.pubkey,
    expires_at: invoiceExpiresAt,
  })

  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: 'RENTAL_CREATED',
    resource_type: 'rental',
    resource_id: rental.id,
    changes: { miner_id, duration_minutes, pool_id, total_sats: totalSats },
    ip_address: req.headers['x-forwarded-for'] || null,
  })

  return res.status(201).json({
    rental_id: rental.id,
    invoice,
    payment_hash: paymentHash,
    amount_sats: totalSats,
    expires_at: invoiceExpiresAt,
    miner: { id: miner.id, name: miner.name },
    pool: POOLS[pool_id],
    payout_address,
    worker_name: workerName,
    duration_minutes,
  })
}
