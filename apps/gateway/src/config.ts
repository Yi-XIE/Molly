import { resolve } from 'node:path';

export interface GatewayConfig {
  port: number;
  databasePath: string;
  publicBaseUrl: string;
  pairingToken: string;
  ownerOpenId: string;
  feishu: {
    appId: string;
    appSecret: string;
    verificationToken: string;
    encryptKey: string;
  };
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const databaseValue = env.MOLLY_GATEWAY_DB ?? './data/gateway.db';
  return {
    port: Number(env.MOLLY_GATEWAY_PORT ?? 4317),
    databasePath: databaseValue === ':memory:' ? databaseValue : resolve(databaseValue),
    publicBaseUrl: env.MOLLY_PUBLIC_BASE_URL ?? `http://127.0.0.1:${env.MOLLY_GATEWAY_PORT ?? 4317}`,
    pairingToken: env.MOLLY_PAIRING_TOKEN ?? '',
    ownerOpenId: env.MOLLY_OWNER_OPEN_ID ?? '',
    feishu: {
      appId: env.FEISHU_APP_ID ?? '',
      appSecret: env.FEISHU_APP_SECRET ?? '',
      verificationToken: env.FEISHU_VERIFICATION_TOKEN ?? '',
      encryptKey: env.FEISHU_ENCRYPT_KEY ?? '',
    },
  };
}
