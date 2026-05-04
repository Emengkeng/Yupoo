/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['puppeteer'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.yupoo.com' },
      { protocol: 'https', hostname: '**.ufs.sh' },
      { protocol: 'https', hostname: 'utfs.io' },
    ],
  },
};

module.exports = nextConfig;
