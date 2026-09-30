// Public Reown/WalletConnect project ID shipped with the template so HashPack works from a fresh
// scaffold. It identifies the dApp to WalletConnect and is not a secret; set
// NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in packages/nextjs/.env.local to use your own.
const TEMPLATE_PROJECT_ID='8292b4aba3c2b7f3b1fc32627d034c38';
export const WALLETCONNECT_PROJECT_ID=process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID||TEMPLATE_PROJECT_ID;