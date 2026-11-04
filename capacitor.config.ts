import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.objectmemory.app',
  appName: 'Mikes Lost Items',
  webDir: 'dist',
  server: {
    url: 'https://object-memory-qap6.vercel.app',
    cleartext: false,
    allowNavigation: ['object-memory-qap6.vercel.app']
  }
};

export default config;