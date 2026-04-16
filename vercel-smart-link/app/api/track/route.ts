import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    const { slug, destination } = await req.json()

    if (!slug || !destination) {
      return NextResponse.json({ ok: false }, { status: 400 })
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || ''

    await supabase.from('utm_clicks').insert({
      slug,
      destination,
      source:     req.headers.get('referer') || 'direct',
      user_agent: req.headers.get('user-agent') || '',
      ip_hash:    ip ? Buffer.from(ip).toString('base64').slice(0, 16) : null,
      created_at: new Date().toISOString(),
    })

    return NextResponse.json({ ok: true })
  } catch {
    // Silent fail — never return error to client (don't block redirects)
    return NextResponse.json({ ok: true })
  }
}
