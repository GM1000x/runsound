import { createClient } from '@supabase/supabase-js'
import { notFound } from 'next/navigation'
import SmartLinkClient from './client'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

interface Song {
  slug: string
  artist_name: string
  title: string
  cover_url: string | null
  spotify_url: string | null
  apple_url: string | null
}

async function getSong(slug: string): Promise<Song | null> {
  const { data, error } = await supabase
    .from('smart_links')
    .select('*')
    .eq('slug', slug)
    .single()

  if (error || !data) return null
  return data
}

export async function generateMetadata({ params }: { params: { slug: string } }) {
  const song = await getSong(params.slug)
  if (!song) return { title: 'Listen Now' }
  return {
    title: `${song.title} — ${song.artist_name}`,
    description: `Stream ${song.title} by ${song.artist_name} on Spotify and Apple Music`,
    openGraph: {
      images: song.cover_url ? [song.cover_url] : [],
    },
  }
}

export default async function SmartLinkPage({ params }: { params: { slug: string } }) {
  const song = await getSong(params.slug)
  if (!song) notFound()
  return <SmartLinkClient song={song} />
}
