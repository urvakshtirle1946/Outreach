import { runAgent } from './agent.js';

async function main() {
  const encodedPayload = process.env.AGENT_PAYLOAD_BASE64;
  if (!encodedPayload) {
    throw new Error('Missing AGENT_PAYLOAD_BASE64');
  }

  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf-8'));
  await runAgent(payload);
}

main().catch((error) => {
  console.error('Agent worker crashed:', error);
  process.exitCode = 1;
});
