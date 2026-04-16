/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' }, // Allow cover art from any domain
    ],
  },
}

module.exports = nextConfig
